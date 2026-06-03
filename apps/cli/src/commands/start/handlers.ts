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
import { postLinkCredential, postAiResult, postPreviewEvent } from '../../services/pairing.service';
import { AGENT_REGISTRY, isKnownAgentId, PREVIEW_DETECT_PROMPT, type AgentId, type PreviewDetection } from '@codeagent/shared';
import {
  activePreviews,
  buildCodespaceUrl,
  isCodespaceSession,
  killPreview,
  parseCloudflaredUrl,
  parseExpoUrl,
  readPreviewConfig,
  registerPreview,
  resolveCloudflared,
  safeParseDetection,
  setPortPublic,
  waitForCloudflaredReady,
  waitForCodespacePortReady,
  writePreviewConfig,
} from '../../services/preview';
import { log } from '../../services/logger';
import type { KeepAliveContext } from './keep-alive';
import { removeSession } from '../../config';

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
  // Lazy-detect when the conversation id hasn't been bound yet.
  // `uploadDelta()` does the same thing on its hot path, but the
  // mobile autoload can fire BEFORE any turn has triggered an
  // upload (cold session re-open, Redis TTL expired and no
  // intermediate write since). Without this, the handler returned
  // `{ conversationId: null }` and the mobile chat sat empty even
  // though the JSONL was sitting on disk waiting to be uploaded.
  let currentId = ctx.historySvc.getCurrentConversationId();
  if (!currentId) {
    ctx.historySvc.detectCurrentConversation();
    currentId = ctx.historySvc.getCurrentConversationId();
  }
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

const sessionTerminated: CommandHandler = async (ctx, cmd) => {
  // Mobile/web "Delete session". Tear down everything and exit.
  showInfo('Session was deleted from the app — exiting.');
  try { await ctx.relay.sendResult(cmd.id, 'success', { ok: true }); } catch { /* best-effort */ }
  try { removeSession(ctx.sessionId); } catch { /* best-effort */ }
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
const requestLinkCredentialsH: CommandHandler = (ctx, _cmd, parsed) => {
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
  const pluginAuthToken = ctx.pluginAuthToken;
  // Fire-and-forget — the locator.extract on macOS hits the keychain
  // (slow) and postLinkCredential is a network round-trip; awaiting
  // either would stall the relay's sequential dispatch loop and
  // block the user's next chat prompt behind a background side-job.
  void (async () => {
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
      pluginAuthToken,
      method: token.method,
      credential: token.credential,
    });
    if (result.ok) {
      log.trace('auto-link', `vaulted ${publicId} from ${token.source}`);
    } else {
      log.trace('auto-link', `upload failed (${result.status}): ${result.message}`);
    }
  })();
};

// AI Insights — turn-end summary. Backend fires this when the user
// has aiInsightsEnabled on this agent AND there were file changes in
// the turn. Runtime strategies that don't implement `generateOneShot`
// (Cursor / Aider / CodeRabbit today) silently no-op.
//
// CRITICAL: The CLI's relay dispatches commands SEQUENTIALLY with
// `await onCommand(cmd)`, so any handler that awaits a long-running
// operation blocks every subsequent command behind it. The agent's
// headless one-shot can take 30-60 s — without fire-and-forget we'd
// stall the user's next `start_task` (their actual chat prompt!)
// behind the background summary generation. Wrap the work in a
// `void (async ...)` IIFE so the handler returns immediately.
const requestAiSummaryH: CommandHandler = (ctx, _cmd, parsed) => {
  if (!ctx.pluginAuthToken) {
    log.info('ai-summary', 'no pluginAuthToken — skipping');
    return;
  }
  if (typeof ctx.runtime.generateOneShot !== 'function') {
    log.info('ai-summary', `runtime ${ctx.runtime.id} has no generateOneShot — skipping`);
    return;
  }
  if (!parsed.prompt || !parsed.turnId || !parsed.stats) {
    log.info(
      'ai-summary',
      `missing fields — prompt=${!!parsed.prompt} turnId=${!!parsed.turnId} stats=${!!parsed.stats}`,
    );
    return;
  }
  const prompt = parsed.prompt;
  const turnId = parsed.turnId;
  const stats = parsed.stats;
  const pluginAuthToken = ctx.pluginAuthToken;
  void (async () => {
    log.info('ai-summary', `generateOneShot start turnId=${turnId} promptLen=${prompt.length}`);
    const startedAt = Date.now();
    const text = await ctx.runtime.generateOneShot!(prompt).catch((err) => {
      log.info('ai-summary', `generateOneShot threw: ${String(err)}`);
      return null;
    });
    const tookMs = Date.now() - startedAt;
    if (!text) {
      log.info('ai-summary', `generateOneShot returned null after ${tookMs}ms — skipping POST`);
      return;
    }
    log.info('ai-summary', `generateOneShot ok turnId=${turnId} took=${tookMs}ms textLen=${text.length}`);
    const result = await postAiResult({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken,
      kind: 'summary',
      turnId,
      summary: text,
      stats,
    });
    if (result.ok) {
      log.info('ai-summary', `postAiResult ok turnId=${turnId}`);
    } else {
      log.info('ai-summary', `postAiResult failed status=${result.status} msg=${result.message}`);
    }
  })();
};

// AI Insights — per-file deep dive. Triggered on file selection.
// Same fire-and-forget pattern as the summary handler so the up-to-
// 60 s headless agent run doesn't block the next user command.
const requestAiInsightH: CommandHandler = (ctx, _cmd, parsed) => {
  if (!ctx.pluginAuthToken) {
    log.info('ai-insight', 'no pluginAuthToken — skipping');
    return;
  }
  if (typeof ctx.runtime.generateOneShot !== 'function') {
    log.info('ai-insight', `runtime ${ctx.runtime.id} has no generateOneShot — skipping`);
    return;
  }
  if (!parsed.prompt || !parsed.fileChangeId) {
    log.info(
      'ai-insight',
      `missing fields — prompt=${!!parsed.prompt} fileChangeId=${!!parsed.fileChangeId}`,
    );
    return;
  }
  const prompt = parsed.prompt;
  const fileChangeId = parsed.fileChangeId;
  const pluginAuthToken = ctx.pluginAuthToken;
  void (async () => {
    log.info('ai-insight', `generateOneShot start fileChangeId=${fileChangeId} promptLen=${prompt.length}`);
    const startedAt = Date.now();
    const text = await ctx.runtime.generateOneShot!(prompt).catch((err) => {
      log.info('ai-insight', `generateOneShot threw: ${String(err)}`);
      return null;
    });
    const tookMs = Date.now() - startedAt;
    if (!text) {
      log.info('ai-insight', `generateOneShot returned null after ${tookMs}ms — skipping POST`);
      return;
    }
    log.info('ai-insight', `generateOneShot ok fileChangeId=${fileChangeId} took=${tookMs}ms textLen=${text.length}`);
    const { summary, reasoning, securityNote } = parseInsightText(text);
    const result = await postAiResult({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken,
      kind: 'insight',
      fileChangeId,
      summary,
      reasoning,
      securityNote,
    });
    if (result.ok) {
      log.info('ai-insight', `postAiResult ok fileChangeId=${fileChangeId}`);
    } else {
      log.info('ai-insight', `postAiResult failed status=${result.status} msg=${result.message}`);
    }
  })();
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

// ─────────────────────────────────────────── In-app preview handlers
//
// Same fire-and-forget pattern as the AI summary / insight handlers
// (lines 556-708 above): the relay dispatches commands SEQUENTIALLY,
// so any handler that blocks behind a 60-90 s agent run or a
// long-lived tunnel spawn stalls the next user command. Each handler
// wraps its body in `void (async … )()` and returns immediately —
// progress flows back to the user via the `preview_*` events on the
// per-user SSE bus.
//
// Authoritative state lives on this plugin process via
// `activePreviews` (services/preview/index.ts). The backend's
// PreviewController is a thin SSE-fanout + Redis-snapshot mirror.

const requestPreviewDetectH: CommandHandler = (ctx) => {
  if (!ctx.pluginAuthToken) {
    log.info('preview', 'no pluginAuthToken — skipping detect');
    return;
  }
  if (typeof ctx.runtime.generateOneShot !== 'function') {
    log.info('preview', `runtime ${ctx.runtime.id} has no generateOneShot — emitting unsupported`);
    void postPreviewEvent({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken: ctx.pluginAuthToken,
      type: 'preview_error',
      payload: {
        stage: 'detection',
        message: `Preview detection isn't available on ${ctx.runtime.id} sessions yet — link a Claude or Codex agent.`,
      },
    });
    return;
  }
  const pluginAuthToken = ctx.pluginAuthToken;
  void (async () => {
    // `.codeam/preview.json` short-circuits the agent step entirely
    // when a repo has been pinned. Saves the user 30-90 s + the LLM
    // tokens, and lets a team commit the override so every dev gets
    // an instant preview on first try.
    const fromFile = await readPreviewConfig(process.cwd());
    if (fromFile) {
      log.info('preview', `detect: using .codeam/preview.json (${fromFile.framework})`);
      void postPreviewEvent({
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        pluginAuthToken,
        type: 'preview_detection_ready',
        payload: { detection: fromFile },
      });
      return;
    }

    void postPreviewEvent({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken,
      type: 'preview_detection_pending',
    });
    log.info('preview', 'detect: invoking generateOneShot');
    const startedAt = Date.now();
    const raw = await ctx.runtime.generateOneShot!(PREVIEW_DETECT_PROMPT).catch((err) => {
      log.info('preview', `detect: generateOneShot threw: ${String(err)}`);
      return null;
    });
    const tookMs = Date.now() - startedAt;
    const detection = safeParseDetection(raw);
    if (!detection) {
      log.info('preview', `detect: invalid agent output after ${tookMs}ms`);
      void postPreviewEvent({
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        pluginAuthToken,
        type: 'preview_error',
        payload: {
          stage: 'detection',
          message:
            'Agent returned invalid JSON. Try again, or add a .codeam/preview.json override.',
        },
      });
      return;
    }
    if (detection.framework === 'unsupported') {
      log.info('preview', 'detect: framework=unsupported');
      void postPreviewEvent({
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        pluginAuthToken,
        type: 'preview_error',
        payload: {
          stage: 'unsupported',
          message: detection.notes ?? 'No dev server applies to this project.',
        },
      });
      return;
    }
    log.info('preview', `detect: ${detection.framework} on :${detection.port} (took ${tookMs}ms)`);
    void postPreviewEvent({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken,
      type: 'preview_detection_ready',
      payload: { detection },
    });
  })();
};

const previewStartH: CommandHandler = (ctx, _cmd, parsed) => {
  if (!ctx.pluginAuthToken) {
    log.info('preview', 'no pluginAuthToken — skipping start');
    return;
  }
  const detection = parsed.detection as PreviewDetection | undefined;
  if (!detection) {
    log.info('preview', 'start: no detection in payload');
    return;
  }
  const pluginAuthToken = ctx.pluginAuthToken;

  void (async () => {
    void postPreviewEvent({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken,
      type: 'preview_starting',
      payload: { framework: detection.framework, port: detection.port },
    });

    // 1. Setup commands (npm install, etc.) — run sequentially.
    for (const setup of detection.setup_commands ?? []) {
      const exitCode = await runOnce(setup.cmd, setup.args, process.cwd(), detection.env);
      if (exitCode !== 0) {
        void postPreviewEvent({
          sessionId: ctx.sessionId,
          pluginId: ctx.pluginId,
          pluginAuthToken,
          type: 'preview_error',
          payload: {
            stage: 'spawn',
            message: `Setup failed (${setup.cmd} ${setup.args.join(' ')}, exit ${exitCode}).`,
          },
        });
        return;
      }
    }

    // 2. Spawn the dev server.
    const devServer = spawn(detection.command, detection.args, {
      cwd: process.cwd(),
      env: { ...process.env, ...(detection.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let readyMatched = false;
    let expoUrl: string | null = null;
    const readyRe = new RegExp(detection.ready_pattern);
    const onChunk = (chunk: Buffer): void => {
      const s = chunk.toString();
      if (!readyMatched && readyRe.test(s)) readyMatched = true;
      if (!expoUrl && detection.framework === 'Expo') expoUrl = parseExpoUrl(s);
    };
    devServer.stdout!.on('data', onChunk);
    devServer.stderr!.on('data', onChunk);

    // 3. Wait for the ready_pattern. Bail if the server exits early
    //    or the 120 s deadline passes.
    const readyDeadline = Date.now() + 120_000;
    while (!readyMatched && Date.now() < readyDeadline) {
      if (devServer.exitCode !== null) {
        void postPreviewEvent({
          sessionId: ctx.sessionId,
          pluginId: ctx.pluginId,
          pluginAuthToken,
          type: 'preview_error',
          payload: {
            stage: 'spawn',
            message: `Dev server exited (code ${devServer.exitCode}).`,
          },
        });
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!readyMatched) {
      try { devServer.kill('SIGTERM'); } catch { /* already dead */ }
      void postPreviewEvent({
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        pluginAuthToken,
        type: 'preview_error',
        payload: { stage: 'ready_timeout', message: "Server didn't signal ready in 120s." },
      });
      return;
    }

    // 4. Tunnel — three branches per the user's session environment.
    let tunnel: ReturnType<typeof spawn> | null = null;
    let url: string;

    if (detection.framework === 'Expo') {
      // Expo manages its own tunnel. We just parsed the URL above —
      // wait a touch longer if it hasn't landed yet.
      if (!expoUrl) {
        const expoDeadline = Date.now() + 15_000;
        while (!expoUrl && Date.now() < expoDeadline) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (!expoUrl) {
        try { devServer.kill('SIGTERM'); } catch { /* already dead */ }
        void postPreviewEvent({
          sessionId: ctx.sessionId,
          pluginId: ctx.pluginId,
          pluginAuthToken,
          type: 'preview_error',
          payload: { stage: 'tunnel', message: 'Expo did not report a tunnel URL.' },
        });
        return;
      }
      url = expoUrl;
    } else if (isCodespaceSession()) {
      const codespaceName = process.env.CODESPACE_NAME!;
      try {
        await setPortPublic(codespaceName, detection.port);
      } catch (e) {
        try { devServer.kill('SIGTERM'); } catch { /* already dead */ }
        void postPreviewEvent({
          sessionId: ctx.sessionId,
          pluginId: ctx.pluginId,
          pluginAuthToken,
          type: 'preview_error',
          payload: { stage: 'tunnel', message: `Failed to flip port public: ${(e as Error).message}` },
        });
        return;
      }
      url = buildCodespaceUrl(codespaceName, detection.port);
      try {
        await waitForCodespacePortReady(url, 15_000);
      } catch (e) {
        try { devServer.kill('SIGTERM'); } catch { /* already dead */ }
        void postPreviewEvent({
          sessionId: ctx.sessionId,
          pluginId: ctx.pluginId,
          pluginAuthToken,
          type: 'preview_error',
          payload: { stage: 'tunnel', message: (e as Error).message },
        });
        return;
      }
    } else {
      // Local — Cloudflare Quick Tunnel via `cloudflared`.
      let bin: string;
      try {
        bin = await resolveCloudflared();
      } catch (e) {
        try { devServer.kill('SIGTERM'); } catch { /* already dead */ }
        void postPreviewEvent({
          sessionId: ctx.sessionId,
          pluginId: ctx.pluginId,
          pluginAuthToken,
          type: 'preview_error',
          payload: { stage: 'tunnel', message: (e as Error).message },
        });
        return;
      }
      tunnel = spawn(bin, ['tunnel', '--url', `http://localhost:${detection.port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let parsedUrl: string | null = null;
      const onTunnelChunk = (chunk: Buffer): void => {
        const s = chunk.toString();
        if (!parsedUrl) parsedUrl = parseCloudflaredUrl(s);
        // Log cloudflared output under [preview] so tunnel issues are
        // post-hoc debuggable without re-running. Trim trailing
        // newlines so one log line == one cloudflared chunk.
        const trimmed = s.replace(/\n+$/g, '');
        if (trimmed.length > 0) log.info('preview', `cloudflared: ${trimmed}`);
      };
      tunnel.stderr!.on('data', onTunnelChunk);
      tunnel.stdout!.on('data', onTunnelChunk);
      // 45 s for the URL to land — cold launches on a fresh
      // cloudflared binary (binary download finishing, QUIC handshake
      // negotiation) used to occasionally miss the previous 15 s
      // budget. The local connector usually prints the URL in <5 s
      // once it's warm.
      const tunnelDeadline = Date.now() + 45_000;
      while (!parsedUrl && Date.now() < tunnelDeadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!parsedUrl) {
        try { tunnel.kill('SIGTERM'); } catch { /* already dead */ }
        try { devServer.kill('SIGTERM'); } catch { /* already dead */ }
        void postPreviewEvent({
          sessionId: ctx.sessionId,
          pluginId: ctx.pluginId,
          pluginAuthToken,
          type: 'preview_error',
          payload: { stage: 'tunnel', message: 'cloudflared did not emit a URL within 45s.' },
        });
        return;
      }
      // cloudflared prints its URL the moment the LOCAL connector is
      // up, but the public `*.trycloudflare.com` hostname takes ~3–10s
      // for DNS to propagate to the mobile device. Without this gate
      // the WebView fires before DNS resolves and shows -1003
      // ("hostname not found"). Probing here moves the wait into the
      // loading state, which is the right surface for it.
      try {
        await waitForCloudflaredReady(parsedUrl, 30_000);
      } catch (e) {
        try { tunnel.kill('SIGTERM'); } catch { /* already dead */ }
        try { devServer.kill('SIGTERM'); } catch { /* already dead */ }
        void postPreviewEvent({
          sessionId: ctx.sessionId,
          pluginId: ctx.pluginId,
          pluginAuthToken,
          type: 'preview_error',
          payload: { stage: 'tunnel', message: (e as Error).message },
        });
        return;
      }
      url = parsedUrl;
    }

    // 5. Register + announce.
    registerPreview(ctx.sessionId, {
      sessionId: ctx.sessionId,
      devServer,
      tunnel,
      url,
      framework: detection.framework,
    });
    log.info('preview', `ready: ${detection.framework} at ${url}`);
    void postPreviewEvent({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken,
      type: 'preview_ready',
      payload: { url, framework: detection.framework, port: detection.port },
    });
  })();
};

const previewStopH: CommandHandler = (ctx) => {
  if (!ctx.pluginAuthToken) {
    log.info('preview', 'no pluginAuthToken — skipping stop');
    return;
  }
  const pluginAuthToken = ctx.pluginAuthToken;
  void (async () => {
    await killPreview(ctx.sessionId);
    log.info('preview', `stopped session=${ctx.sessionId}`);
    void postPreviewEvent({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken,
      type: 'preview_stopped',
      payload: { reason: 'user' },
    });
  })();
};

/**
 * Run a single setup command (e.g. `npm install`, `prisma generate`)
 * detached from the CLI's stdout. Output is captured to the
 * `[preview]` log so it's still debuggable, but the host terminal
 * stays clean — the user's `codeam pair` session shouldn't fill up
 * with `npm WARN` lines every time they tap Start Preview. Earlier
 * versions used `stdio: 'inherit'` and that pollution is exactly
 * what the mobile UI's "contaminated terminal" report flagged.
 */
function runOnce(
  cmd: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tag = `setup:${cmd}`;
    const onChunk = (chunk: Buffer): void => {
      // Trim trailing newlines so each captured chunk lands as one
      // log line. Empty payloads (just `\n`) get dropped.
      const text = chunk.toString().replace(/\n+$/g, '');
      if (text.length === 0) return;
      log.info('preview', `${tag}: ${text}`);
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(-1));
  });
}

/**
 * Save the confirmed detection to `.codeam/preview.json` so the next
 * `request_preview_detect` short-circuits the agent step. Mobile /
 * web call this when the user toggles "Remember for this project"
 * on the confirmation sheet. Fire-and-forget — failure to write the
 * file is non-fatal (the agent step still works next time).
 */
const savePreviewConfigH: CommandHandler = (_ctx, _cmd, parsed) => {
  const detection = parsed.detection as PreviewDetection | undefined;
  if (!detection) {
    log.info('preview', 'save_preview_config: no detection in payload');
    return;
  }
  void writePreviewConfig(process.cwd(), detection).catch((err) => {
    log.info('preview', `save_preview_config failed: ${String(err)}`);
  });
};

// Re-export for sigintHandler in start.ts so it can walk every active
// preview on session shutdown.
export { activePreviews };

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
  request_preview_detect: requestPreviewDetectH,
  preview_start: previewStartH,
  preview_stop: previewStopH,
  save_preview_config: savePreviewConfigH,
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
