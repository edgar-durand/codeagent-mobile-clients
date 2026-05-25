import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import type { AgentService } from '../../services/agent.service';
import type { CommandRelayService, RemoteCommand } from '../../services/command-relay.service';
import type { HistoryService } from '../../services/history.service';
import type { OutputService } from '../../services/output.service';
import type { RuntimeStrategy } from '../../agents/strategy';
import {
  parsePayload,
  startCommandSchema,
  type FileEntry,
  type StartCommandPayload,
} from '../../lib/payload';
import { readProjectFile, writeProjectFile } from '../../services/file-ops.service';
import {
  listProjectFiles,
  gitStatus,
  gitDiff,
  gitDiffStaged,
  gitLog,
  gitCommit,
  gitPush,
  gitPull,
  gitResolve,
  searchFiles,
} from '../../services/project-ops.service';
import {
  openTerminal,
  writeTerminal,
  resizeTerminal,
  closeTerminal,
} from '../../services/terminal-ops.service';
import { showInfo } from '../../ui/banner';
import { applyFileReview } from '../../services/apply-file-review.service';
import { buildLinkContext } from '../link';
import { postLinkCredential, postAiResult } from '../../services/pairing.service';
import { AGENT_REGISTRY, isKnownAgentId, type AgentId } from '@codeagent/shared';
import { log } from '../../services/logger';
import type { KeepAliveContext } from './keep-alive';

/**
 * Shared dependency container for command handlers.
 *
 * Constructed once in `start.ts` and threaded through every
 * handler so each one stays free of module-level singletons +
 * gets a unit-testable surface (replace any field with a fake).
 */
export interface HandlerContext {
  outputSvc: OutputService;
  agent: AgentService;
  historySvc: HistoryService;
  relay: CommandRelayService;
  runtime: RuntimeStrategy;
  setKeepAlive: (enabled: boolean) => void;
  keepAliveCtx: KeepAliveContext;
  /** Paired-session credentials needed by handlers that talk to the
   *  /api/plugin/* endpoints (e.g. auto-link). Older paired sessions
   *  from before pluginAuthToken existed leave it undefined — those
   *  handlers should no-op gracefully. */
  pluginId: string;
  sessionId: string;
  pluginAuthToken?: string;
}

/**
 * Each entry handles ONE remote command type. Returns a Promise
 * that resolves once the command is fully handled (including any
 * `relay.sendResult` calls). Unrecognised types map to nothing —
 * the dispatcher logs and skips.
 */
export type CommandHandler = (
  ctx: HandlerContext,
  cmd: RemoteCommand,
  parsed: StartCommandPayload,
) => Promise<void> | void;

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Process-wide set of attachment temp files still pending cleanup.
 * Each `start_task` with attachments registers paths here AND schedules
 * a 120s setTimeout to unlink them. On hard exit (SIGINT / SIGTERM /
 * SIGHUP / agent onExit), `cleanupAttachmentTempFiles()` drains the set
 * eagerly so the user's /tmp doesn't accumulate orphan attachments
 * across kills. Audit anchor: R12.
 */
const pendingAttachmentFiles = new Set<string>();

/** Best-effort eager cleanup of attachment temp files. Called from
 *  signal handlers + the agent onExit path so /tmp doesn't leak. */
export function cleanupAttachmentTempFiles(): void {
  for (const p of pendingAttachmentFiles) {
    try { fs.unlinkSync(p); } catch { /* already gone */ }
  }
  pendingAttachmentFiles.clear();
}

/**
 * Saves base64-encoded attachments to per-temp-file paths so they
 * can be referenced as `@path` arguments for Claude. Returns the
 * resolved temp paths in the order they were supplied. Each path
 * is registered in `pendingAttachmentFiles` so a SIGINT mid-turn
 * doesn't leave the files behind.
 */
function saveFilesTemp(files: FileEntry[]): string[] {
  return files
    .filter(({ base64 }) => base64 && base64.length > 0)
    .map(({ filename, base64 }) => {
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      const tmpPath = path.join(os.tmpdir(), `codeam-${randomUUID()}-${safeName}`);
      fs.writeFileSync(tmpPath, Buffer.from(base64, 'base64'));
      pendingAttachmentFiles.add(tmpPath);
      return tmpPath;
    });
}

function dispatchPrompt(ctx: HandlerContext, prompt: string): void {
  ctx.outputSvc.newTurn();
  ctx.agent.sendCommand(prompt);
}

// ─── Agent control ───────────────────────────────────────────────

const startTask: CommandHandler = (ctx, _cmd, parsed) => {
  const { prompt, files } = parsed;
  const effectivePrompt = prompt ?? '';
  if (files && files.length > 0) {
    const paths = saveFilesTemp(files);
    const atRefs = paths.map((p) => `@${p}`).join(' ');
    ctx.outputSvc.newTurn();
    ctx.agent.sendCommand(`${atRefs} ${effectivePrompt}`.trim());
    setTimeout(() => {
      for (const p of paths) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
        pendingAttachmentFiles.delete(p);
      }
    }, 120_000);
  } else if (effectivePrompt) {
    dispatchPrompt(ctx, effectivePrompt);
  }
};

const provideInput: CommandHandler = (ctx, _cmd, parsed) => {
  if (parsed.input) dispatchPrompt(ctx, parsed.input);
};

const selectOption: CommandHandler = (ctx, _cmd, parsed) => {
  // Navigate React Ink's selector to the chosen option and confirm.
  // Must use `claude.selectOption()` — arrows + Enter must be paced
  // so React Ink batches the keypress events correctly.
  const index = parsed.index ?? 0;
  const from = parsed.from ?? 0;
  ctx.outputSvc.newTurn();
  ctx.agent.selectOption(index, from);
};

const escapeKey: CommandHandler = (ctx) => {
  ctx.outputSvc.newTurn();
  ctx.agent.sendEscape();
};

const stopTask: CommandHandler = (ctx) => {
  ctx.agent.interrupt();
};

const resumeSession: CommandHandler = async (ctx, _cmd, parsed) => {
  const { id, auto } = parsed;
  if (!id) return;
  ctx.historySvc.setCurrentConversationId(id);
  await ctx.historySvc.loadConversation(id);
  await ctx.outputSvc.newTurnResume(id);
  ctx.agent.restart(id, auto ?? false);
};

// ─── Read-only context queries ───────────────────────────────────

const getContext: CommandHandler = async (ctx, cmd) => {
  const usage = ctx.historySvc.getCurrentUsage();
  const monthlyCost = ctx.historySvc.getMonthlyEstimatedCost();
  const rateLimitReset = ctx.historySvc.getRateLimitReset();
  const quotaPercent = ctx.historySvc.getQuotaPercent();
  const base = usage
    ? { ...usage, monthlyCost }
    : { used: 0, total: 200000, percent: 0, model: null, outputTokens: 0, cacheReadTokens: 0, monthlyCost, error: 'No usage data found' };
  const result = {
    ...base,
    ...(rateLimitReset ? { rateLimitReset } : {}),
    ...(quotaPercent !== null ? { quotaPercent } : {}),
  };
  await ctx.relay.sendResult(cmd.id, 'completed', result as Record<string, unknown>);
};

const getConversation: CommandHandler = async (ctx, cmd) => {
  const currentId = ctx.historySvc.getCurrentConversationId();
  if (!currentId) {
    await ctx.relay.sendResult(cmd.id, 'completed', { conversationId: null });
    return;
  }
  try {
    await ctx.historySvc.loadConversation(currentId);
    await ctx.relay.sendResult(cmd.id, 'completed', { conversationId: currentId });
  } catch {
    await ctx.relay.sendResult(cmd.id, 'failed', {});
  }
};

const listModels: CommandHandler = async (ctx, cmd) => {
  // Delegate to the runtime so each agent returns its own catalog.
  // Claude returns the static Anthropic model list; future agents
  // (e.g. Codex) will return OpenAI models without touching this file.
  const models = await ctx.runtime.listModels();
  await ctx.relay.sendResult(cmd.id, 'completed', { models });
};

const changeModel: CommandHandler = async (ctx, cmd) => {
  const params = cmd.payload as { modelId?: unknown };
  if (typeof params.modelId !== 'string' || !params.modelId) {
    await ctx.relay.sendResult(cmd.id, 'failed', { error: 'modelId required' });
    return;
  }
  const instr = ctx.runtime.changeModelInstruction(params.modelId);
  if (instr.type === 'pty') {
    if (!instr.ptyInput) {
      await ctx.relay.sendResult(cmd.id, 'failed', { error: 'no pty input for this agent' });
      return;
    }
    ctx.agent.sendRawPtyInput(instr.ptyInput);
  } else if (instr.type === 'restart') {
    // Restart path — Claude doesn't use this in Phase 1, but the design
    // supports it for future agents. Defer full implementation.
    await ctx.relay.sendResult(cmd.id, 'failed', { error: 'restart-mode change_model not supported in Phase 1' });
    return;
  }
  await ctx.relay.sendResult(cmd.id, 'completed', {});
};

const summarize: CommandHandler = async (ctx, cmd) => {
  const params = cmd.payload as { mode?: unknown };
  const mode: 'normal' | 'auto' = params.mode === 'auto' ? 'auto' : 'normal';
  const instr = ctx.runtime.summarizeInstruction(mode);
  ctx.agent.sendRawPtyInput(instr.ptyInput);
  await ctx.relay.sendResult(cmd.id, 'completed', {});
};

// ─── Lifecycle ───────────────────────────────────────────────────

const setKeepAlive: CommandHandler = async (ctx, cmd) => {
  // Mobile/web "Avoid suspend codespace on inactivity" toggle. Only
  // meaningful inside a GitHub Codespace (CODESPACES=true) — locally
  // the toggle is a no-op and we report that back so the apps can
  // hide it.
  const enabled = !!cmd.payload.enabled;
  ctx.setKeepAlive(enabled);
  try {
    await ctx.relay.sendResult(
      cmd.id,
      'success',
      {
        enabled,
        applied: enabled && ctx.keepAliveCtx.inCodespace,
        runtime: ctx.keepAliveCtx.inCodespace ? 'github-codespaces' : 'local',
      },
    );
  } catch { /* ignore */ }
};

const sessionTerminated: CommandHandler = (ctx) => {
  // Mobile/web "Delete session". Tear down everything and exit.
  showInfo('Session was deleted from the app — exiting.');
  try { ctx.agent.kill(); } catch { /* best-effort */ }
  try {
    const proc = spawn('bash', ['-lc', 'pm2 delete codeam-pair >/dev/null 2>&1 || true'], {
      detached: true,
      stdio: 'ignore',
    });
    proc.unref();
  } catch { /* pm2 may not be installed locally; ignore */ }
  ctx.outputSvc.dispose();
  ctx.relay.stop();
  process.exit(0);
};

const shutdownSession: CommandHandler = async (ctx, cmd) => {
  // Mobile/web "Stop session". Tear down PM2 supervisor + kill
  // Claude + exit. Inside a Codespace, also `gh codespace stop` so
  // the workspace itself suspends and the user stops paying for
  // compute hours.
  try { await ctx.relay.sendResult(cmd.id, 'success', { ok: true }); } catch { /* best-effort */ }
  try { ctx.agent.kill(); } catch { /* best-effort */ }
  if (ctx.keepAliveCtx.inCodespace && ctx.keepAliveCtx.codespaceName) {
    try {
      const stopProc = spawn(
        'bash',
        ['-lc', `sleep 1; gh codespace stop -c ${JSON.stringify(ctx.keepAliveCtx.codespaceName)} >/dev/null 2>&1 || true`],
        { detached: true, stdio: 'ignore' },
      );
      stopProc.unref();
    } catch { /* gh may be unavailable; ignore */ }
  }
  try {
    const proc = spawn('bash', ['-lc', 'pm2 delete codeam-pair >/dev/null 2>&1 || true'], {
      detached: true,
      stdio: 'ignore',
    });
    proc.unref();
  } catch { /* ignore */ }
  ctx.outputSvc.dispose();
  ctx.relay.stop();
  process.exit(0);
};

// ─── Mini-IDE file ops ───────────────────────────────────────────

const readFile: CommandHandler = async (ctx, cmd, parsed) => {
  if (!parsed.path) {
    await ctx.relay.sendResult(cmd.id, 'failed', { error: 'Missing path' });
    return;
  }
  const result = await readProjectFile(parsed.path);
  await ctx.relay.sendResult(cmd.id, 'completed', result as Record<string, unknown>);
};

const writeFile: CommandHandler = async (ctx, cmd, parsed) => {
  if (!parsed.path || typeof parsed.content !== 'string') {
    await ctx.relay.sendResult(cmd.id, 'failed', { error: 'Missing path or content' });
    return;
  }
  const result = await writeProjectFile(parsed.path, parsed.content);
  await ctx.relay.sendResult(cmd.id, 'completed', result as Record<string, unknown>);
};

const listFiles: CommandHandler = async (ctx, cmd, parsed) => {
  const result = await listProjectFiles({ query: parsed.query });
  await ctx.relay.sendResult(cmd.id, 'completed', result as unknown as Record<string, unknown>);
};

const terminalOpenH: CommandHandler = async (ctx, cmd, parsed) => {
  const r = openTerminal({
    cols: typeof parsed.cols === 'number' ? parsed.cols : undefined,
    rows: typeof parsed.rows === 'number' ? parsed.rows : undefined,
    cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
  });
  if ('error' in r) {
    await ctx.relay.sendResult(cmd.id, 'failed', { error: r.error });
    return;
  }
  await ctx.relay.sendResult(cmd.id, 'completed', r as unknown as Record<string, unknown>);
};

const terminalWriteH: CommandHandler = async (ctx, cmd, parsed) => {
  if (typeof parsed.sessionId !== 'string' || typeof parsed.data !== 'string') {
    await ctx.relay.sendResult(cmd.id, 'failed', { error: 'Missing sessionId or data' });
    return;
  }
  const r = writeTerminal(parsed.sessionId, parsed.data);
  await ctx.relay.sendResult(cmd.id, r.ok ? 'completed' : 'failed', r as unknown as Record<string, unknown>);
};

const terminalResizeH: CommandHandler = async (ctx, cmd, parsed) => {
  if (typeof parsed.sessionId !== 'string' || typeof parsed.cols !== 'number' || typeof parsed.rows !== 'number') {
    await ctx.relay.sendResult(cmd.id, 'failed', { error: 'Missing sessionId / cols / rows' });
    return;
  }
  const r = resizeTerminal(parsed.sessionId, parsed.cols, parsed.rows);
  await ctx.relay.sendResult(cmd.id, r.ok ? 'completed' : 'failed', r as unknown as Record<string, unknown>);
};

const terminalCloseH: CommandHandler = async (ctx, cmd, parsed) => {
  if (typeof parsed.sessionId !== 'string') {
    await ctx.relay.sendResult(cmd.id, 'failed', { error: 'Missing sessionId' });
    return;
  }
  const r = closeTerminal(parsed.sessionId);
  await ctx.relay.sendResult(cmd.id, 'completed', r as unknown as Record<string, unknown>);
};

const searchFilesH: CommandHandler = async (ctx, cmd, parsed) => {
  if (!parsed.query || typeof parsed.query !== 'string') {
    await ctx.relay.sendResult(cmd.id, 'failed', { error: 'Missing query' });
    return;
  }
  const result = await searchFiles({
    query: parsed.query,
    caseSensitive: parsed.caseSensitive,
    wholeWord: parsed.wholeWord,
    regex: parsed.regex,
    include: Array.isArray(parsed.include) ? parsed.include : undefined,
    exclude: Array.isArray(parsed.exclude) ? parsed.exclude : undefined,
    maxResults: typeof parsed.maxResults === 'number' ? parsed.maxResults : undefined,
  });
  await ctx.relay.sendResult(cmd.id, 'completed', result as unknown as Record<string, unknown>);
};

// ─── Git ops ─────────────────────────────────────────────────────

const gitStatusH: CommandHandler = async (ctx, cmd) => {
  const result = await gitStatus();
  await ctx.relay.sendResult(cmd.id, 'completed', result as unknown as Record<string, unknown>);
};

const gitDiffH: CommandHandler = async (ctx, cmd, parsed) => {
  const result = await gitDiff(parsed.path ?? null);
  await ctx.relay.sendResult(cmd.id, 'completed', result as Record<string, unknown>);
};

const gitDiffStagedH: CommandHandler = async (ctx, cmd, parsed) => {
  const result = await gitDiffStaged(parsed.path ?? null);
  await ctx.relay.sendResult(cmd.id, 'completed', result as Record<string, unknown>);
};

const gitLogH: CommandHandler = async (ctx, cmd, parsed) => {
  const result = await gitLog(parsed.limit ?? 30);
  await ctx.relay.sendResult(cmd.id, 'completed', result as unknown as Record<string, unknown>);
};

const gitCommitH: CommandHandler = async (ctx, cmd, parsed) => {
  if (!parsed.message) {
    await ctx.relay.sendResult(cmd.id, 'failed', { error: 'Missing message' });
    return;
  }
  const result = await gitCommit(parsed.message, parsed.paths);
  await ctx.relay.sendResult(cmd.id, 'completed', result as Record<string, unknown>);
};

const gitPushH: CommandHandler = async (ctx, cmd) => {
  const result = await gitPush();
  await ctx.relay.sendResult(cmd.id, 'completed', result as Record<string, unknown>);
};

const gitPullH: CommandHandler = async (ctx, cmd) => {
  const result = await gitPull();
  await ctx.relay.sendResult(cmd.id, 'completed', result as Record<string, unknown>);
};

const gitResolveH: CommandHandler = async (ctx, cmd, parsed) => {
  if (!parsed.path || !parsed.side) {
    await ctx.relay.sendResult(cmd.id, 'failed', { error: 'Missing path or side' });
    return;
  }
  const result = await gitResolve(parsed.path, parsed.side);
  await ctx.relay.sendResult(cmd.id, 'completed', result as Record<string, unknown>);
};

// Epic B follow-up — backend pushes this when the user clicks
// APPROVE_CHANGES / REJECT_CHANGES on a file in the diff drawer.
// `approved` → `git add <filePath>`. `rejected` → `git restore
// <filePath>` (discards every worktree edit on the file, not just
// the rejected hunks — drawer surfaces a confirm dialog before
// firing).
const applyFileReviewH: CommandHandler = async (ctx, cmd, parsed) => {
  if (!parsed.filePath || !parsed.action) {
    await ctx.relay.sendResult(cmd.id, 'failed', {
      error: 'Missing filePath or action',
    });
    return;
  }
  const result = await applyFileReview(
    process.cwd(),
    parsed.filePath,
    parsed.action,
  );
  await ctx.relay.sendResult(
    cmd.id,
    result.ok ? 'completed' : 'failed',
    result as unknown as Record<string, unknown>,
  );
};

// Backend pushes this from the heartbeat side-effect when the user
// is running an agent they haven't vaulted yet. We reuse the
// `codeam link` token-capture path — but ONLY the best-effort
// disk-read step. If no local credentials are found, the handler
// no-ops silently — we never spawn the interactive sign-in here
// because that would surprise the user mid-session. They can still
// run `codeam link <agent>` manually to opt in.
const requestLinkCredentialsH: CommandHandler = async (ctx, _cmd, parsed) => {
  const publicId = parsed.agentId;
  if (!publicId) return;
  if (!ctx.pluginAuthToken) {
    log.trace('auto-link', 'skipped — no pluginAuthToken on this paired session');
    return;
  }

  // Public id → internal id (LinkedAgent uses `claude_code`, runtime
  // factory takes `claude`). Other ids are identical across both.
  const internalId: AgentId = publicId === 'claude_code' ? 'claude' : (publicId as AgentId);
  if (!isKnownAgentId(internalId) || !AGENT_REGISTRY[internalId].enabled) {
    log.trace('auto-link', `unknown / disabled agent: ${internalId}`);
    return;
  }

  let linkCtx;
  try {
    linkCtx = buildLinkContext(internalId);
  } catch (err) {
    log.trace('auto-link', 'buildLinkContext threw', err);
    return;
  }

  const token = await linkCtx.locator.extract().catch((err) => {
    log.trace('auto-link', `locator.extract failed for ${publicId}`, err);
    return null;
  });
  if (!token) {
    log.trace('auto-link', `no local ${linkCtx.displayName} credentials — skipping`);
    return;
  }

  const result = await postLinkCredential({
    agentId: publicId,
    sessionId: ctx.sessionId,
    pluginId: ctx.pluginId,
    pluginAuthToken: ctx.pluginAuthToken,
    method: token.method,
    credential: token.credential,
  });
  if (result.ok) {
    log.trace('auto-link', `vaulted ${publicId} from ${token.source}`);
  } else {
    log.trace('auto-link', `upload failed (${result.status}): ${result.message}`);
  }
};

// AI Insights — turn-end summary. Backend fires this when the user
// has aiInsightsEnabled on this agent AND there were file changes in
// the turn. Runtime strategies that don't implement `generateOneShot`
// (Cursor / Aider / CodeRabbit today) silently no-op.
const requestAiSummaryH: CommandHandler = async (ctx, _cmd, parsed) => {
  if (!ctx.pluginAuthToken) return;
  if (typeof ctx.runtime.generateOneShot !== 'function') return;
  if (!parsed.prompt || !parsed.turnId || !parsed.stats) {
    log.trace('ai-summary', 'missing prompt/turnId/stats — skipping');
    return;
  }
  const text = await ctx.runtime.generateOneShot(parsed.prompt).catch((err) => {
    log.trace('ai-summary', 'generateOneShot threw', err);
    return null;
  });
  if (!text) return;
  await postAiResult({
    sessionId: ctx.sessionId,
    pluginId: ctx.pluginId,
    pluginAuthToken: ctx.pluginAuthToken,
    kind: 'summary',
    turnId: parsed.turnId,
    summary: text,
    stats: parsed.stats,
  });
};

// AI Insights — per-file deep dive. Triggered on file selection.
const requestAiInsightH: CommandHandler = async (ctx, _cmd, parsed) => {
  if (!ctx.pluginAuthToken) return;
  if (typeof ctx.runtime.generateOneShot !== 'function') return;
  if (!parsed.prompt || !parsed.fileChangeId) {
    log.trace('ai-insight', 'missing prompt/fileChangeId — skipping');
    return;
  }
  const text = await ctx.runtime.generateOneShot(parsed.prompt).catch((err) => {
    log.trace('ai-insight', 'generateOneShot threw', err);
    return null;
  });
  if (!text) return;
  // Insight pulls a short summary + a longer reasoning block from the
  // agent's response. The prompt the backend renders asks the agent
  // to output `SUMMARY:\n…\n\nREASONING:\n…` so we can split on the
  // labels. If the format doesn't match, fall back to using the whole
  // blob as both fields — the UI tolerates duplicates.
  const { summary, reasoning, securityNote } = parseInsightText(text);
  await postAiResult({
    sessionId: ctx.sessionId,
    pluginId: ctx.pluginId,
    pluginAuthToken: ctx.pluginAuthToken,
    kind: 'insight',
    fileChangeId: parsed.fileChangeId,
    summary,
    reasoning,
    securityNote,
  });
};

function parseInsightText(text: string): {
  summary: string;
  reasoning: string;
  securityNote?: string;
} {
  const summaryMatch = text.match(/SUMMARY:\s*([\s\S]*?)(?=\n\s*(?:REASONING|SECURITY):|$)/i);
  const reasoningMatch = text.match(/REASONING:\s*([\s\S]*?)(?=\n\s*SECURITY:|$)/i);
  const securityMatch = text.match(/SECURITY:\s*([\s\S]*)/i);
  return {
    summary: (summaryMatch?.[1] ?? text).trim(),
    reasoning: (reasoningMatch?.[1] ?? text).trim(),
    securityNote: securityMatch?.[1]?.trim() || undefined,
  };
}

// ─── Dispatch table ──────────────────────────────────────────────

export const handlers: Record<string, CommandHandler> = {
  start_task: startTask,
  provide_input: provideInput,
  select_option: selectOption,
  escape_key: escapeKey,
  stop_task: stopTask,
  resume_session: resumeSession,
  get_context: getContext,
  get_conversation: getConversation,
  list_models: listModels,
  change_model: changeModel,
  summarize,
  set_keep_alive: setKeepAlive,
  session_terminated: sessionTerminated,
  shutdown_session: shutdownSession,
  read_file: readFile,
  write_file: writeFile,
  list_files: listFiles,
  search_files: searchFilesH,
  terminal_open: terminalOpenH,
  terminal_write: terminalWriteH,
  terminal_resize: terminalResizeH,
  terminal_close: terminalCloseH,
  git_status: gitStatusH,
  git_diff: gitDiffH,
  git_diff_staged: gitDiffStagedH,
  git_log: gitLogH,
  git_commit: gitCommitH,
  git_push: gitPushH,
  git_pull: gitPullH,
  git_resolve: gitResolveH,
  apply_file_review: applyFileReviewH,
  request_link_credentials: requestLinkCredentialsH,
  request_ai_summary: requestAiSummaryH,
  request_ai_insight: requestAiInsightH,
};

/**
 * Dispatcher entry point — called by the relay's onCommand
 * callback. Validates the command's payload against the shared
 * Zod schema, looks up the handler by command type, and lets it
 * execute. Unknown / malformed commands are logged and dropped
 * so a misbehaving server can't crash the CLI.
 */
export async function dispatchCommand(
  ctx: HandlerContext,
  cmd: RemoteCommand,
): Promise<void> {
  const parsed = parsePayload(startCommandSchema, cmd.payload);
  if (!parsed) {
    showInfo(`Ignoring malformed ${cmd.type} payload.`);
    return;
  }
  const handler = handlers[cmd.type];
  if (!handler) return;
  await handler(ctx, cmd, parsed);
}
