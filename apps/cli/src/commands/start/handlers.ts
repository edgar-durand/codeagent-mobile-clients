import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { spawn, spawnSync, execFile } from 'child_process';
import which from 'which';
import type { AgentService } from '../../services/agent.service';
import type { BatonController } from '../../baton/baton-controller';
import {
  stopRelayWithGoodbye,
  type CommandRelayService,
  type RemoteCommand,
} from '../../services/command-relay.service';
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
import { postLinkCredential, postAiResult, postPreviewEvent, postHeadroomEvent, postBeadsEvent, postCliUpdateEvent, postCoderabbitEvent, postAgentReviewReport, fetchProvisionCredential } from '../../services/pairing.service';
import { configureCoderabbit, type CoderabbitAction } from '../../agents/coderabbit/configure';
import { deliverPendingCoderabbitCallback, type CoderabbitAuthEvent } from '../../agents/coderabbit/oauth';
import { CoderabbitRuntimeStrategy } from '../../agents/coderabbit/runtime';
import { reviewPullRequest, defaultRunGh } from '../../agents/coderabbit/review-pr';
import { createOsStrategy } from '../../os';
import {
  agentIdToHeadroomKind,
  isHeadroomSupportedAgent,
  persistHeadroomConfig,
  headroomConfigPath,
  restoreAgentHeadroomConfig,
  setupHeadroomForSelfHosted,
} from '../../commands/host-agent';
import { buildBudgetProxyArgs } from '../../services/headroom/budget-args';
import { configureHeadroom } from '../../services/headroom/configure';
import { applyBudgetToHeadroom, makeRealApplyBudgetDeps, type BudgetSpec } from '../../services/headroom/budget-relaunch';
import { fetchWithTimeout, HeadroomStatsReporter, mapStatsToSavings, type StatsShape, type Savings } from '../../services/headroom/stats-reporter';
import { killHeadroomProxy } from '../../services/headroom/proxy-pid';
import { readUsageReport } from '../../services/headroom/usage-report';
import { getGuardrailPolicy, setGuardrailPolicy } from '../../agents/acp/guardrail-config';
import { AGENT_REGISTRY, isKnownAgentId, normalizeAgentId, PREVIEW_DETECT_PROMPT, USER_EVENTS, type PreviewDetection, type HeadroomBudgetCommand } from '@codeam/shared';
import * as previewSvc from '../../services/preview';
import { runPreviewStart, type EmitPreviewEvent } from '../../services/preview/start-orchestrator';
import {
  restoreProjectEnvIfMissing,
  syncProjectEnvUp,
} from '../../services/project-env';
import {
  activePreviews,
  killPreview,
  parseDotenv,
  serializeDotenv,
  ENV_KEY_RE,
  readPreviewConfig,
  safeParseDetection,
  writePreviewConfig,
} from '../../services/preview';
import { log } from '../../services/logger';
import type { KeepAliveContext } from './keep-alive';
import { removeSession } from '../../config';
import { quiet, rmIfExistsQuiet } from '../../lib/quiet';
import { handleBeadsActionCommand, type StartedBeads, startBeads } from '../../beads';
import { beadsActionFromPayload } from '../../beads/wiring';
import { configureBeads, probeBeadsStatus, type ConfigureBeadsDeps } from '../../beads/configure';
import { persistBeadsConfig, readBeadsEnabled } from '../../beads/config-store';
import { configureSkill, type SkillsConfigureAction } from '../../skills/configure';
import { provisionBeads } from '../../beads/provisioner';
import type { BeadsConfigureAction } from '@codeam/shared';
// Self-namespace import: `previewRestartH` invokes `startPreviewFromDetection`
// through this object (not the direct local binding) so a unit test can
// `vi.spyOn(handlersMod, 'startPreviewFromDetection')` and intercept the call —
// an in-module direct call references the local binding and bypasses the spy
// under this repo's esbuild/CJS transform, which would let the REAL dev-server
// bring-up run during the test. The exported signature is unchanged.
import * as self from './handlers';

/**
 * Shared dependency container for command handlers.
 *
 * Constructed once in `start.ts` and threaded through every
 * handler so each one stays free of module-level singletons +
 * gets a unit-testable surface (replace any field with a fake).
 */
/**
 * Fields every command handler can rely on — agent-AGNOSTIC. The preview / file
 * / git / terminal / link handlers (the ones an ACP session or the no-agent
 * infra-only path reuse) read ONLY these, so a caller that has no PTY pipeline
 * (the ACP `buildLegacyContextForACP`) can construct one HONESTLY, with no
 * `as unknown as` cast fabricating the PTY machinery it doesn't own.
 */
export interface BaseHandlerContext {
  relay: CommandRelayService;
  runtime: RuntimeStrategy;
  /** Paired-session credentials needed by handlers that talk to the
   *  /api/plugin/* endpoints (e.g. auto-link). Older paired sessions
   *  from before pluginAuthToken existed leave it undefined — those
   *  handlers should no-op gracefully. */
  pluginId: string;
  sessionId: string;
  /** The agent id this session is actually running (e.g. `claude`, `codex`).
   *  The authoritative source for "what agent am I?" — set by start.ts from
   *  `session.agent`. Handlers (e.g. headroom_configure) must prefer this over
   *  any client-supplied agent hint, which can be absent or stale. */
  agentId: string;
  pluginAuthToken?: string;
  /** Live Beads session (watcher + adapter) when beads provisioned for
   *  this run; null when beads is off (kill-switch, no bd, provisioning
   *  failure). Set by the composition root (`start.ts`) once
   *  `provisionBeadsForStart` resolves. `beads_action` commands are no-ops
   *  while this is null. */
  beads?: StartedBeads | null;
  /** Live baton controller when this session runs the local-session-baton
   *  feature (set by the composition root once the feature is enabled for
   *  this session). Undefined for sessions without a baton — `take_control`
   *  / `handback` ack `failed` with `{ code: 'NO_BATON' }` in that case. */
  baton?: BatonController;
}

/**
 * The FULL context for a PTY-backed session — adds the machinery the chat
 * pipeline handlers (start_task, provide_input, summarize, resume_session, …)
 * dereference. Only the PTY `start()` composition root supplies these.
 */
export interface PtyHandlerContext extends BaseHandlerContext {
  outputSvc: OutputService;
  agent: AgentService;
  historySvc: HistoryService;
  setKeepAlive: (enabled: boolean) => void;
  keepAliveCtx: KeepAliveContext;
}

/**
 * The context most handlers + `dispatchCommand`'s registry are typed against.
 * Kept as an alias of {@link PtyHandlerContext} so the ~60 existing references
 * (and every PTY handler that reads `outputSvc`/`agent`/…) are unchanged; the
 * agent-agnostic subset is {@link BaseHandlerContext}.
 */
export type HandlerContext = PtyHandlerContext;

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
    rmIfExistsQuiet(p);
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

const startTask: CommandHandler = async (ctx, cmd, parsed) => {
  const { prompt, files } = parsed;
  // PTY sessions can't switch agents mid-session — a routed task naming a
  // DIFFERENT agent would otherwise silently run on the wrong one instead of
  // failing honestly (the ACP path has `switchAgentH`'s equivalent guard).
  if (parsed.agentId && parsed.agentId !== ctx.agentId) {
    await ctx.relay.sendResult(cmd.id, 'failed', {
      error: "Switching agents isn't supported on this session.",
    });
    return;
  }
  const effectivePrompt = prompt ?? '';
  if (files && files.length > 0) {
    const paths = saveFilesTemp(files);
    const atRefs = paths.map((p) => `@${p}`).join(' ');
    ctx.outputSvc.newTurn();
    ctx.agent.sendCommand(`${atRefs} ${effectivePrompt}`.trim());
    setTimeout(() => {
      for (const p of paths) {
        rmIfExistsQuiet(p);
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
  quiet(() => ctx.agent.kill());
  try {
    const proc = spawn('bash', ['-lc', 'pm2 delete codeam-pair >/dev/null 2>&1 || true'], {
      detached: true,
      stdio: 'ignore',
    });
    proc.unref();
  } catch { /* pm2 may not be installed locally; ignore */ }
  ctx.outputSvc.dispose();
  // AWAITED goodbye so the backend flips this session offline immediately
  // (a fire-and-forget heartbeat never survives the process.exit below).
  await stopRelayWithGoodbye(ctx.relay);
  process.exit(0);
};

const shutdownSession: CommandHandler = async (ctx, cmd) => {
  // Mobile/web "Stop session". Tear down PM2 supervisor + kill
  // Claude + exit. Inside a Codespace, also `gh codespace stop` so
  // the workspace itself suspends and the user stops paying for
  // compute hours.
  try { await ctx.relay.sendResult(cmd.id, 'success', { ok: true }); } catch { /* best-effort */ }
  quiet(() => ctx.agent.kill());
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
  // AWAITED goodbye so the backend flips this session offline immediately
  // (a fire-and-forget heartbeat never survives the process.exit below).
  await stopRelayWithGoodbye(ctx.relay);
  process.exit(0);
};

// Backend pushes this when the user picks a device from the
// self-hosted setup flow. We DISPLAY the install one-liner so the
// user can copy it onto their own box — we NEVER execute it. The
// command string is validated by `startCommandSchema` before it
// reaches here.
const showInstallCommand: CommandHandler = async (ctx, cmd, parsed) => {
  const command = parsed.command;
  if (!command) {
    await ctx.relay.sendResult(cmd.id, 'failed', { error: 'Missing command' });
    return;
  }
  showInfo('CodeAgent — self-hosted install. Run this on your box:');
  showInfo('');
  showInfo(`    ${command}`);
  showInfo('');
  await ctx.relay.sendResult(cmd.id, 'completed', {});
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

// ─── Environment config (env vars editor) ───────────────────────

const envReadH: CommandHandler = async (ctx, cmd) => {
  const envPath = path.join(process.cwd(), '.env');
  // Reuse: on a fresh session of a repo whose `.env` we've stored before,
  // restore it first so the Environment Variables screen shows the saved vars
  // (and the dev server later picks them up). No-op if a `.env` already exists.
  await restoreProjectEnvIfMissing(process.cwd(), ctx);
  try {
    const raw = await fs.promises.readFile(envPath, 'utf8');
    await ctx.relay.sendResult(cmd.id, 'completed', {
      exists: true,
      vars: parseDotenv(raw),
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await ctx.relay.sendResult(cmd.id, 'completed', { exists: false, vars: [] });
      return;
    }
    await ctx.relay.sendResult(cmd.id, 'failed', { error: (err as Error).message });
  }
};

const envWriteH: CommandHandler = async (ctx, cmd, parsed) => {
  const vars = parsed.vars;
  if (!Array.isArray(vars)) {
    await ctx.relay.sendResult(cmd.id, 'failed', { error: 'Missing vars' });
    return;
  }
  const seen = new Set<string>();
  for (const v of vars) {
    if (!ENV_KEY_RE.test(v.key)) {
      await ctx.relay.sendResult(cmd.id, 'failed', { error: `Invalid key: ${v.key}` });
      return;
    }
    if (seen.has(v.key)) {
      await ctx.relay.sendResult(cmd.id, 'failed', { error: `Duplicate key: ${v.key}` });
      return;
    }
    seen.add(v.key);
  }
  const envPath = path.join(process.cwd(), '.env');
  const tmpPath = path.join(process.cwd(), '.env.codeam.tmp');
  try {
    await fs.promises.writeFile(tmpPath, serializeDotenv(vars), 'utf8');
    await fs.promises.rename(tmpPath, envPath); // atomic replace
    await ctx.relay.sendResult(cmd.id, 'completed', { ok: true, count: vars.length });
    // Persist the latest `.env` to the backend vault so a future session of the
    // same repo (fresh codespace / box / machine) can restore it. Best-effort,
    // fire-and-forget — never blocks or fails the local write.
    void syncProjectEnvUp(process.cwd(), ctx);
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
    await ctx.relay.sendResult(cmd.id, 'failed', { error: (err as Error).message });
  }
};

// ─── Agent Skills (on-demand add/remove/list on a RUNNING session) ─

const skillsConfigureH: CommandHandler = async (ctx, cmd, parsed) => {
  const action = parsed.action as SkillsConfigureAction | undefined;
  const res = configureSkill(action ?? 'list', parsed.skillId);
  await ctx.relay.sendResult(cmd.id, res.ok ? 'completed' : 'failed', res);
};

// ─── Session baton (take_control / handback) ─────────────────────

const takeControlH: CommandHandler = async (ctx, cmd) => {
  if (!ctx.baton) {
    await ctx.relay.sendResult(cmd.id, 'failed', { code: 'NO_BATON' });
    return;
  }
  try {
    await ctx.baton.takeControl();
  } catch {
    await ctx.relay.sendResult(cmd.id, 'failed', { code: 'BATON_SWITCH_FAILED' });
    return;
  }
  await ctx.relay.sendResult(cmd.id, 'completed', { state: ctx.baton.state });
};

const handbackH: CommandHandler = async (ctx, cmd) => {
  if (!ctx.baton) {
    await ctx.relay.sendResult(cmd.id, 'failed', { code: 'NO_BATON' });
    return;
  }
  try {
    await ctx.baton.handback();
  } catch {
    await ctx.relay.sendResult(cmd.id, 'failed', { code: 'BATON_SWITCH_FAILED' });
    return;
  }
  await ctx.relay.sendResult(cmd.id, 'completed', { state: ctx.baton.state });
};

// ─── Headroom on-demand configure ────────────────────────────────

/** Per-session stats reporter instance — started on `enable`, stopped on `disable`. */
let _activeReporter: HeadroomStatsReporter | null = null;

/**
 * Serializes Headroom SSE event POSTs. `configureHeadroom` emits the
 * `headroom_progress` steps (pip…ready) and the terminal `headroom_status`
 * (enabled/disabled/error) back-to-back. If each POST were fired-and-forgotten
 * concurrently, the backend's per-event `findActiveSessionByPlugin` lookup
 * (variable latency) could `userEvents.publish` them out of order — a late
 * `proxy`/`ready` progress landing after `enabled` leaves the mobile UI stuck
 * on "Starting proxy…". Chaining each POST after the previous one guarantees
 * the backend receives — and republishes — them in emit order.
 */
let _headroomEmitChain: Promise<unknown> = Promise.resolve();

const headroomConfigureH: CommandHandler = async (ctx, cmd, parsed) => {
  const action = parsed.action;
  if (action !== 'enable' && action !== 'disable' && action !== 'status') {
    await ctx.relay.sendResult(cmd.id, 'failed', { error: 'action must be enable|disable|status' });
    return;
  }

  const savingsIngestUrl = parsed.savingsIngestUrl;

  // Resolve which agent this is for. The running session's OWN agent
  // (`ctx.agentId`, set by start.ts from `session.agent`) is authoritative — the
  // CLI launched it, so it always knows the truth. A client-supplied hint
  // (`parsed.agentId`) is only a fallback, and the persisted config is last.
  //
  // ⚠️ Previously this read ONLY `parsed.agentId`, but the mobile cost-saving
  // flow sends `{action:'enable'}` with NO agentId → `rawAgentId === ''` →
  // `isHeadroomSupportedAgent('')` is false → a real Claude session got a
  // spurious `{supported:false}`. Preferring `ctx.agentId` fixes that.
  // Normalize public-id aliases (`claude_code` → `claude`, …) via the shared
  // normalizer so the value is consistent with what `requestLinkCredentialsH`
  // writes; unknown ids pass through untouched for the downstream gate.
  let rawAgentId = ctx.agentId || (typeof parsed.agentId === 'string' ? parsed.agentId : '');
  rawAgentId = normalizeAgentId(rawAgentId) ?? rawAgentId;
  let configuredAgent = rawAgentId;
  if (!configuredAgent) {
    try {
      const raw = JSON.parse(fs.readFileSync(headroomConfigPath(), 'utf8')) as { agent?: string };
      configuredAgent = raw.agent ?? '';
    } catch { /* no config yet */ }
  }

  const result = await configureHeadroom(action, {
    agent: configuredAgent,
    pluginAuthToken: ctx.pluginAuthToken,
    savingsIngestUrl,
  }, {
    setup: setupHeadroomForSelfHosted,
    probeStats: async (): Promise<Savings | null> => {
      try {
        const res = await fetchWithTimeout('http://localhost:8787/stats');
        if (!res.ok) return null;
        const raw = await res.json() as StatsShape;
        return mapStatsToSavings(raw, {
          rawTokensEst: 0, sentTokensEst: 0, cachedTokens: 0, retrieveHops: 0,
          cacheReadTokens: 0, cacheSavingsUsd: 0, compressionTokens: 0,
          compressionSavingsUsd: 0, compressionPct: 0,
        }).next;
      } catch {
        return null;
      }
    },
    persist: persistHeadroomConfig,
    readEnabled: () => {
      try {
        const raw = JSON.parse(fs.readFileSync(headroomConfigPath(), 'utf8')) as { enabled?: boolean };
        return raw.enabled === true;
      } catch {
        return false;
      }
    },
    startReporter: (opts) => {
      _activeReporter?.stop();
      const reporter = new HeadroomStatsReporter({
        fetchStats: async () => {
          const res = await fetchWithTimeout('http://localhost:8787/stats');
          return res.json() as Promise<StatsShape>;
        },
        postSavings: async (delta, budget) => {
          if (!opts.ingestUrl) return;
          const res = await fetchWithTimeout(opts.ingestUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(opts.pluginAuthToken ? { 'X-Plugin-Auth-Token': opts.pluginAuthToken } : {}),
            },
            // Body MUST match HeadroomSavingsDto + PluginAuthGuard, which read
            // `sessionId` + `pluginId` from the body and 401 if either is
            // missing. Mirror the self-hosted reporter in host-agent.ts exactly.
            // Previously this sent `{ agentId, ...delta }` (no sessionId/pluginId,
            // delta spread flat instead of nested under `savings`) → every POST
            // was rejected 401 at the guard and silently swallowed (fetch status
            // unchecked), so local on-demand savings never reached the backend.
            body: JSON.stringify({
              sessionId: ctx.sessionId,
              pluginId: ctx.pluginId,
              agentId: opts.agent,
              savings: delta,
              ...(budget ? {
                periodSpendUsd: budget.periodSpendUsd,
                budgetUsd: budget.budgetUsd,
                budgetPeriod: budget.budgetPeriod,
                budgetReached: budget.budgetReached,
              } : {}),
            }),
          });
          // A rejected POST (401 guard, 403 plan gate, 5xx) means the delta
          // was NOT credited — surface it instead of silently swallowing (the
          // exact failure mode of the incident recounted above).
          if (!res.ok) {
            log.warn('headroom', `savings POST rejected ${res.status} — delta not credited`);
          }
        },
      });
      reporter.start();
      _activeReporter = reporter;
    },
    stopReporter: () => {
      _activeReporter?.stop();
      _activeReporter = null;
    },
    restoreAgentHeadroomConfig: (kind: string) => restoreAgentHeadroomConfig(kind),
    // Targeted pidfile kill; falls back to the legacy pkill pattern only when
    // no live recorded pid exists. Best-effort — never throws.
    stopProxy: () => killHeadroomProxy(),
    emit: (event) => {
      const token = ctx.pluginAuthToken;
      if (!token) return;
      // Serialize: chain this POST after the previous one so the backend
      // receives progress/status events strictly in emit order (see
      // `_headroomEmitChain`). A failed POST resolves to `ok:false` rather than
      // rejecting, so the chain never breaks for later events.
      _headroomEmitChain = _headroomEmitChain.then(() =>
        postHeadroomEvent({
          sessionId: ctx.sessionId,
          pluginId: ctx.pluginId,
          pluginAuthToken: token,
          type: event.type,
          payload: 'step' in event ? { step: event.step } : { state: event.state },
        }),
      );
    },
  });

  await ctx.relay.sendResult(cmd.id, 'completed', result);
};

// ─── CodeRabbit reviewer ─────────────────────────────────────────────────────

/**
 * `coderabbit_configure` relay handler — the mobile "Link CodeRabbit reviewer" /
 * "Review" add-on (available on ANY code session: local, codespace, self-hosted).
 * Actions: `status | link_oauth | link_apikey | review`. The OAuth link streams
 * the browser `authUrl` + phases to the app via `postCoderabbitEvent`; the
 * captured (filename-agnostic) credential is stored in the backend vault via
 * `postLinkCredential` so it's reusable across the user's sessions. Logic lives
 * in `agents/coderabbit/configure.ts` — this handler is only the relay glue.
 */
const coderabbitConfigureH: CommandHandler = async (ctx, cmd, parsed) => {
  const rawAction = parsed.action ?? 'status';
  const token = ctx.pluginAuthToken;

  // Serialized event chain so `authUrl`/phase events reach the backend (and the
  // app) strictly in emit order — same discipline as headroom's emit chain.
  let emitChain: Promise<unknown> = Promise.resolve();
  const emit = (type: 'coderabbit_progress' | 'coderabbit_status', payload: Record<string, unknown>): void => {
    if (!token) return;
    emitChain = emitChain.then(() =>
      postCoderabbitEvent({
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        pluginAuthToken: token,
        type,
        payload,
      }),
    );
  };

  // ── Session-relay OAuth: deliver the mobile-intercepted redirect ──────────
  // The WebView on the phone catches CodeRabbit's loopback redirect and relays
  // the exact URL here; we replay it to THIS host's `coderabbit auth login`
  // loopback so a remote-host `link_oauth` (below) completes. Stateless + quick
  // (a loopback GET), so it never blocks the relay — critical, because the
  // in-flight `link_oauth` login is what it unblocks.
  if (rawAction === 'link_deliver_callback') {
    const r = deliverPendingCoderabbitCallback(parsed.callbackUrl ?? '');
    await ctx.relay.sendResult(cmd.id, r.ok ? 'completed' : 'failed', {
      action: 'link_deliver_callback',
      supported: true,
      installed: true,
      loggedIn: false,
      delivered: r.ok,
      ...(r.error ? { error: r.error } : {}),
    });
    return;
  }

  const action = rawAction as CoderabbitAction;

  const onEvent = (e: CoderabbitAuthEvent): void => {
    if (e.kind === 'awaiting_browser') {
      emit('coderabbit_progress', {
        phase: 'awaiting_browser',
        authUrl: e.authUrl,
        fallbackAuthUrl: e.fallbackAuthUrl,
      });
    } else {
      emit('coderabbit_progress', { phase: e.kind });
    }
  };
  const uploadCredential = token
    ? async (method: 'oauth' | 'api_key', credential: string): Promise<boolean> => {
        const r = await postLinkCredential({
          agentId: 'coderabbit',
          sessionId: ctx.sessionId,
          pluginId: ctx.pluginId,
          pluginAuthToken: token,
          method,
          credential,
          // ⚠️ CodeRabbit is an IN-SESSION reviewer add-on — the link ALWAYS
          // rides the user's REAL active session (codespace / self-hosted /
          // local), never a throwaway `codeam link` pairing. Without this the
          // backend `linkFromCli` treats the session as the disposable
          // handshake session and DELETES it — the codespace vanished the
          // instant the OAuth link completed (2026-07-10).
          preserveSession: true,
        });
        return r.ok === true;
      }
    : undefined;

  // ── Provision from the vault: NO re-login. Fetch the caller's already-vaulted
  // CodeRabbit credential from the backend and restore it onto this session
  // (install + write login-state). ACK immediately + run in the BACKGROUND
  // (install can take ~30-60s); the outcome reaches mobile via coderabbit_status.
  if (action === 'provision') {
    await ctx.relay.sendResult(cmd.id, 'completed', {
      action: 'provision',
      supported: true,
      installed: false,
      loggedIn: false,
      linked: false,
    });
    void (async () => {
      try {
        const cred = token
          ? await fetchProvisionCredential({
              agentId: 'coderabbit',
              sessionId: ctx.sessionId,
              pluginId: ctx.pluginId,
              pluginAuthToken: token,
            })
          : null;
        if (!cred) {
          emit('coderabbit_status', {
            installed: false,
            loggedIn: false,
            linked: false,
            error: 'No vaulted CodeRabbit credential — sign in once to link it.',
          });
          await emitChain;
          return;
        }
        const result = await configureCoderabbit(
          { action: 'provision', provisionCredential: cred },
          { onEvent },
        );
        emit('coderabbit_status', {
          installed: result.installed,
          loggedIn: result.loggedIn,
          linked: result.linked ?? false,
          ...(result.error ? { error: result.error } : {}),
        });
      } catch (err) {
        emit('coderabbit_status', {
          installed: false,
          loggedIn: false,
          linked: false,
          error: err instanceof Error ? err.message : 'CodeRabbit provisioning failed',
        });
      }
      await emitChain;
    })();
    return;
  }

  // ── OAuth link: run the (browser-gated, long) login in the BACKGROUND ─────
  // `coderabbit auth login --agent` blocks on its loopback until the redirect
  // arrives — which only happens once the app relays it via
  // `link_deliver_callback`. If we awaited it here, the relay's SERIAL poll-path
  // dispatch would never reach that delivery command → deadlock. So we ACK the
  // command immediately and drive the link login in the background; the outcome
  // reaches mobile via the `coderabbit_status` event (its canonical signal),
  // exactly like the blocking path below.
  if (action === 'link_oauth') {
    await ctx.relay.sendResult(cmd.id, 'completed', {
      action: 'link_oauth',
      supported: true,
      installed: true,
      loggedIn: false,
      linked: false,
    });
    void (async () => {
      try {
        const result = await configureCoderabbit({ action: 'link_oauth' }, { onEvent, uploadCredential });
        emit('coderabbit_status', {
          installed: result.installed,
          loggedIn: result.loggedIn,
          linked: result.linked ?? false,
          ...(result.error ? { error: result.error } : {}),
        });
      } catch (err) {
        emit('coderabbit_status', {
          installed: false,
          loggedIn: false,
          linked: false,
          error: err instanceof Error ? err.message : 'CodeRabbit login failed',
        });
      }
      await emitChain;
    })();
    return;
  }

  // ── status | link_apikey | review — quick, so blocking is fine ────────────
  const result = await configureCoderabbit(
    {
      action,
      apiKey: parsed.apiKey,
      review: { changeSet: parsed.changeSet, base: parsed.base, dir: parsed.reviewDir },
    },
    {
      onEvent,
      uploadCredential,
      runReview: (input) => new CoderabbitRuntimeStrategy(createOsStrategy()).runOneShot(input),
    },
  );

  // Terminal status snapshot for the app's CodeRabbit slot — ONLY for
  // status/link actions. A `review` result has no `linked` field, so emitting
  // here would publish `linked:false` and clobber a previously-confirmed link,
  // bouncing the app back to the sign-in screen mid-review.
  if (action !== 'review') {
    emit('coderabbit_status', {
      installed: result.installed,
      loggedIn: result.loggedIn,
      linked: result.linked ?? false,
      ...(result.error ? { error: result.error } : {}),
    });
  }
  await emitChain;
  await ctx.relay.sendResult(cmd.id, result.error && action !== 'review' ? 'failed' : 'completed', result);
};

// ─── VCS agent review (PR/MR Command Center, Phase 2) ───────────────────────

/**
 * `vcs_agent_review` relay handler — "Ask an agent to review PR #X".
 *
 * Spec: docs/superpowers/specs/2026-07-18-pr-mr-command-center-design.md §6.
 *
 * ONLY CodeRabbit needs CLI code: it's the one reviewer that isn't ACP and has
 * no GitHub-posting of its own, so the CLI runs `coderabbit review` over the
 * checked-out PR branch, then posts the findings + verdict to GitHub with `gh`
 * (already authenticated on the box) and POSTs an `AgentReviewReport` back.
 *
 * For ACP agents (claude / codex / gemini) this is a deliberate NO-OP — the
 * backend delivers the review task to them as an initial prompt and they call
 * `gh pr review` / `gh api` themselves. The handler is fanned to every active
 * relay session, so it guards on THIS session's authoritative agent id
 * (`ctx.agentId`) and skips cleanly for anything but CodeRabbit.
 *
 * ACKs immediately, then runs the review in the BACKGROUND (a real review can
 * take minutes); the outcome reaches the app via the backend completion push
 * fired from the posted report — not this command's result.
 */
const vcsAgentReviewH: CommandHandler = async (ctx, cmd, parsed) => {
  const pr = parsed.pr;
  if (!pr) {
    await ctx.relay.sendResult(cmd.id, 'failed', { error: 'Missing PR reference' });
    return;
  }
  const prRef = {
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    ...(pr.url ? { url: pr.url } : {}),
  };

  // Only the CodeRabbit path is CLI-driven. `ctx.agentId` is the authoritative
  // "what agent is this session running" — never trust a client-supplied hint.
  if (normalizeAgentId(ctx.agentId) !== 'coderabbit') {
    await ctx.relay.sendResult(cmd.id, 'completed', {
      action: 'vcs_agent_review',
      skipped: true,
      reason: 'non-coderabbit agent posts its review via the prompt + gh',
    });
    return;
  }

  await ctx.relay.sendResult(cmd.id, 'completed', {
    action: 'vcs_agent_review',
    started: true,
  });

  const token = ctx.pluginAuthToken;
  void (async () => {
    const os = createOsStrategy();
    try {
      const report = await reviewPullRequest(
        {
          prRef,
          agentId: 'coderabbit',
          baseBranch: parsed.baseBranch,
        },
        {
          runReview: (input) => new CoderabbitRuntimeStrategy(os).runOneShot(input),
          runGh: (args) => defaultRunGh(args),
          postReport: async (r) => {
            if (!token) return;
            await postAgentReviewReport({
              sessionId: ctx.sessionId,
              pluginId: ctx.pluginId,
              pluginAuthToken: token,
              report: r,
            });
          },
        },
      );
      log.info(
        'vcs',
        `agent review of ${prRef.owner}/${prRef.repo}#${prRef.number} posted: ` +
          `${report.verdict} (${report.commentCount} inline comment(s))`,
      );
    } catch (err) {
      log.warn('vcs', 'agent PR review failed (non-fatal)', err);
    }
  })();
};

// ─── Headroom budget ───────────────────────────────────────────────────────

/**
 * `headroom_budget` relay handler.
 *
 * The backend fans this command to ALL active relay sessions for the user
 * (PairedSession has no agentId on the server). This handler therefore guards
 * on three conditions before touching anything:
 *   1. Headroom is ACTIVE (enabled) in THIS session's persisted config.
 *   2. This session's agent matches the command's `payload.agentId` (the
 *      backend carrier field that lets the CLI discriminate per-agent).
 *   3. `isHeadroomSupportedAgent(agent)` — cursor/gemini/aider are never
 *      Headroom-wrappable; skip silently so their sessions are unaffected.
 *
 * When all three pass:
 *   - Set/clear `HEADROOM_BUDGET` / `HEADROOM_BUDGET_PERIOD` on `process.env`
 *     so `readHeadroomChildEnv` picks them up on any future child spawn.
 *   - Kill the running proxy (pkill -TERM -f 'headroom.*proxy').
 *   - Relaunch the proxy detached with `buildBudgetProxyArgs` so it enforces
 *     the new budget immediately (no pip/init/model steps — just re-spawn).
 *   - Return `relay.sendResult(cmd.id, 'completed', { applied: true })`.
 *
 * Otherwise: no-op → `{ applied: false }` (no proxy restart, no env mutation).
 */
/**
 * `headroom_usage` — return the session's token-usage report, read from the
 * local Headroom proxy's durable `/stats-history` and trimmed on-box (see
 * services/headroom/usage-report.ts for the size/fidelity/privacy rationale).
 *
 * Read-only and unconditional: it never mutates the proxy and it does NOT gate
 * on the agent, because the report is about the proxy running HERE. When
 * Headroom isn't active the proxy simply isn't listening and we answer
 * `{ available: false }` — an honest empty state instead of an error. The app
 * only offers the entry point for Headroom-capable agents anyway.
 */
const headroomUsageH: CommandHandler = async (ctx, cmd) => {
  try {
    const report = await readUsageReport();
    if (!report) {
      await ctx.relay.sendResult(cmd.id, 'completed', {
        available: false,
        error: 'Headroom is not running in this session.',
      });
      return;
    }
    await ctx.relay.sendResult(cmd.id, 'completed', { available: true, report });
  } catch (err) {
    await ctx.relay.sendResult(cmd.id, 'completed', {
      available: false,
      error: (err as Error).message,
    });
  }
};

const headroomBudgetH: CommandHandler = async (ctx, cmd) => {
  const payload = cmd.payload as unknown as HeadroomBudgetCommand;

  // ── 1. Resolve this session's agent (same pattern as headroom_configure). ──
  // ctx.agentId (set by start.ts from session.agent) is authoritative.
  // payload.agentId is the backend-supplied carrier for the guard — used to
  // identify WHICH agent's budget is being set; we compare it against ctx.agentId.
  let rawAgentId = ctx.agentId || (typeof payload.agentId === 'string' ? payload.agentId : '');
  rawAgentId = normalizeAgentId(rawAgentId) ?? rawAgentId;

  // Normalise the payload carrier too, for comparison.
  let payloadAgentId = typeof payload.agentId === 'string' ? payload.agentId : '';
  payloadAgentId = normalizeAgentId(payloadAgentId) ?? payloadAgentId;

  // ── 2. Guard: must be a supported agent. ────────────────────────────────
  if (!rawAgentId || !isHeadroomSupportedAgent(rawAgentId)) {
    await ctx.relay.sendResult(cmd.id, 'completed', { applied: false });
    return;
  }

  // ── 3. Guard: payload.agentId must target THIS session's agent. ─────────
  // The backend sends the same command to every open session. Only the session
  // whose agent matches the budget target should apply it.
  if (!payloadAgentId || payloadAgentId !== rawAgentId) {
    await ctx.relay.sendResult(cmd.id, 'completed', { applied: false });
    return;
  }

  // ── 4. Guard: Headroom must be ACTIVE in this session. ─────────────────
  let headroomActive = false;
  try {
    const raw = JSON.parse(fs.readFileSync(headroomConfigPath(), 'utf8')) as {
      enabled?: boolean;
      agent?: string;
    };
    headroomActive = raw.enabled === true;
  } catch {
    /* no config file or bad JSON — treat as inactive */
  }
  if (!headroomActive) {
    await ctx.relay.sendResult(cmd.id, 'completed', { applied: false });
    return;
  }

  // ── 5. Persist budget into ~/.codeam/headroom-config.json AND process.env. ──
  // Persisting to the config file means self-hosted supervisor restarts and
  // reboots pick up the budget via `readHeadroomChildEnv` without needing the
  // parent process env (which is ephemeral across restarts).
  // We also mirror to process.env so the proxy relaunch below picks them up
  // immediately for the current process's `buildBudgetProxyArgs` call.
  let existingConfig: {
    enabled?: boolean;
    agent?: string;
    ingestUrl?: string;
    budgetEnabled?: boolean;
    budgetUsd?: number;
    budgetPeriod?: string;
  } = { enabled: true };
  try {
    existingConfig = JSON.parse(fs.readFileSync(headroomConfigPath(), 'utf8')) as typeof existingConfig;
  } catch {
    /* use defaults */
  }

  if (payload.budgetEnabled && payload.budgetUsd != null) {
    persistHeadroomConfig({
      ...existingConfig,
      enabled: existingConfig.enabled ?? true,
      budgetEnabled: true,
      budgetUsd: payload.budgetUsd,
      budgetPeriod: (payload.budgetPeriod as 'hourly' | 'daily' | 'monthly' | undefined) ?? 'daily',
    });
    process.env['HEADROOM_BUDGET'] = String(payload.budgetUsd);
    process.env['HEADROOM_BUDGET_PERIOD'] = payload.budgetPeriod ?? 'daily';
  } else {
    persistHeadroomConfig({
      ...existingConfig,
      enabled: existingConfig.enabled ?? true,
      budgetEnabled: false,
      budgetUsd: undefined,
      budgetPeriod: undefined,
    });
    delete process.env['HEADROOM_BUDGET'];
    delete process.env['HEADROOM_BUDGET_PERIOD'];
  }

  // ── 6+7. Kill+respawn OR amend supervised deployment manifest ───────────────
  // When `headroom install` manages the proxy, direct kill+respawn loses the
  // port race — the supervisor instantly respawns without --budget.
  // applyBudgetToHeadroom detects supervised deployments (port===8787 manifests
  // at ~/.headroom/deploy/*/manifest.json) and routes accordingly.
  const budgetSpec: BudgetSpec | null =
    payload.budgetEnabled && payload.budgetUsd != null
      ? {
          budgetUsd: payload.budgetUsd,
          budgetPeriod: (payload.budgetPeriod as 'hourly' | 'daily' | 'monthly' | undefined) ?? 'daily',
        }
      : null;

  await applyBudgetToHeadroom(budgetSpec, makeRealApplyBudgetDeps());

  await ctx.relay.sendResult(cmd.id, 'completed', { applied: true });
};

// ─── Beads configure ─────────────────────────────────────────────

/**
 * Serializes Beads SSE event POSTs. Mirrors `_headroomEmitChain` to guarantee
 * the backend receives — and republishes — `beads_status` events strictly in
 * emit order. A failed POST resolves to `ok:false` rather than rejecting, so
 * the chain never breaks for later events.
 */
let _beadsEmitChain: Promise<unknown> = Promise.resolve();

const beadsConfigureH: CommandHandler = async (ctx, cmd, parsed) => {
  const action = parsed.action as BeadsConfigureAction | undefined;
  if (action !== 'enable' && action !== 'disable' && action !== 'status') {
    await ctx.relay.sendResult(cmd.id, 'failed', { error: 'action must be enable|disable|status' });
    return;
  }

  // Use the session's own running agent — same resolution as headroom_configure.
  let rawAgentId = ctx.agentId || (typeof parsed.agentId === 'string' ? parsed.agentId : '');
  rawAgentId = normalizeAgentId(rawAgentId) ?? rawAgentId;

  const agentIds = rawAgentId && isKnownAgentId(rawAgentId) ? [rawAgentId] : [];

  const deps: ConfigureBeadsDeps = {
    provision: async () => {
      const r = await provisionBeads({ cwd: process.cwd(), agents: agentIds });
      return { bdAvailable: r.bdAvailable, doltAvailable: r.doltAvailable, serverUp: r.serverUp, prefix: r.prefix };
    },
    probe: async () => probeBeadsStatus(process.cwd()),
    startWatcher: async () => {
      if (!ctx.pluginAuthToken) return;
      const started = await startBeads({
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        pluginAuthToken: ctx.pluginAuthToken,
        cwd: process.cwd(),
        agents: agentIds,
      });
      if (started) {
        ctx.beads = started;
      }
    },
    stopWatcher: async () => {
      if (ctx.beads) {
        await ctx.beads.watcher.stop();
        ctx.beads = null;
      }
    },
    revertAgentHook: async (agent: string) => {
      // `bd setup <recipe> --global --remove` does not exist in the bd CLI
      // (verified: bd ships no un-setup/remove flag). The disable contract is:
      // persist enabled:false + stop the watcher. The agent hook (CLAUDE.md
      // SessionStart `bd prime`) is left in place — it runs at zero cost when
      // Beads is off (bd prime fast-paths to empty). No-op + log is intentional.
      log.info('beads', `revertAgentHook: bd has no --remove flag — leaving ${agent} hook in place (no-op disable path)`);
    },
    persist: (cfg) => persistBeadsConfig(cfg),
    readEnabled: () => readBeadsEnabled(),
    emit: (event) => {
      const token = ctx.pluginAuthToken;
      if (!token) return;
      // Serialize: chain this POST after the previous one so the backend
      // receives status events strictly in emit order (see `_beadsEmitChain`).
      _beadsEmitChain = _beadsEmitChain.then(() =>
        postBeadsEvent({
          sessionId: ctx.sessionId,
          pluginId: ctx.pluginId,
          pluginAuthToken: token,
          type: USER_EVENTS.BEADS_STATUS,
          payload: Object.fromEntries(
            Object.entries(event).filter(([k]) => k !== 'type'),
          ),
        }),
      );
    },
  };

  const result = await configureBeads(action, { agent: rawAgentId, cwd: process.cwd(), pluginAuthToken: ctx.pluginAuthToken }, deps);
  await ctx.relay.sendResult(cmd.id, 'completed', result);
};

// ─── CLI self-update ─────────────────────────────────────────────

/**
 * Injectable re-launch seam — replaced by tests so `process.exit` / `spawn`
 * never run inside the test runner. The real implementation chooses the path
 * based on the execution context at call time:
 *
 *   - **Supervised** (`CODEAM_AUTO_APPROVE === '1'`): the HostAgentSupervisor
 *     does NOT auto-restart children on exit (confirmed from the `proc.once('exit')`
 *     handler in host-agent.ts ~line 2335: it only removes the child from the map
 *     and fires a one-shot `reportSessionEvent`). Therefore we do NOT exit —
 *     instead we leave the process running. The update is still installed on
 *     disk; it applies on the NEXT natural restart (systemd or a fresh deploy).
 *     We document this via a log line and report `relaunching` (indicating the
 *     update is ready, not that a live re-exec happened).
 *
 *   - **Local `codeam start` / `codeam pair`** (no supervised markers):
 *     re-exec SYNCHRONOUSLY in the foreground — `spawnSync('codeam', args,
 *     { stdio: 'inherit' })`, then `process.exit(child.status)`. This mirrors
 *     the proven boot-time upgrade in `updateNotifier.maybeAutoUpdate`: the
 *     child runs in the SAME process group and keeps the controlling terminal,
 *     so an interactive TUI session relaunches in place. A detached re-exec +
 *     immediate `process.exit(0)` (the previous implementation) orphaned that
 *     TUI — the parent left the foreground, the shell reclaimed the TTY, and
 *     the detached child got SIGTTIN and never came up ("closed the session
 *     but couldn't relaunch it"). We also re-exec `codeam` from PATH rather
 *     than the stale `process.argv[1]`, so the freshly-installed binary takes
 *     over; the local path is gated off codespace/self-hosted (see
 *     `isSupervised`), where `codeam` is always on PATH.
 */
export interface CliUpdateDeps {
  /** Run the npm install — injectable so tests don't spawn npm. */
  install: () => Promise<{ ok: boolean; error?: string }>;
  /** Detect whether this process is a supervised pair-auto child. */
  isSupervised: () => boolean;
  /** Perform the actual exit / re-exec — injected so tests can assert the
   *  decision without killing the test runner. */
  relaunch: (args: string[]) => void;
}

export const defaultCliUpdateDeps: CliUpdateDeps = {
  install: () => runNpmInstallLatest(),
  // "Don't self-relaunch" gate — leave this process running and let the
  // on-disk update apply on the next natural restart, instead of killing it:
  //   - self-hosted (CODEAM_AUTO_APPROVE=1): the HostAgentSupervisor does NOT
  //     auto-restart children on exit, so exiting would orphan the session.
  //   - codespace (CODESPACES=true): the pair-auto daemon owns a daemon lock +
  //     the relay connection; a naive detached re-exec does NOT replicate the
  //     careful setsid/lock-aware restart the install flow uses, so a failed
  //     respawn would leave the mobile session permanently OFFLINE. Codespaces
  //     sleep/resume often, so the update lands on next wake — safe + non-fatal.
  // Only a truly local `codeam start` (neither marker) re-execs in place below.
  isSupervised: () =>
    process.env['CODEAM_AUTO_APPROVE'] === '1' || process.env['CODESPACES'] === 'true',
  relaunch: (args: string[]) => {
    // Foreground, SYNCHRONOUS re-exec via `codeam` from PATH (the freshly
    // installed binary), mirroring updateNotifier.maybeAutoUpdate. Keeping the
    // child in the same process group preserves the controlling terminal so an
    // interactive local session (`codeam pair`) relaunches in place instead of
    // being orphaned by a detached re-exec. See the CliUpdateDeps JSDoc.
    const child = spawnSync('codeam', args, { stdio: 'inherit', env: process.env });
    process.exit(child.status ?? 0);
  },
};

/** Timeout for the `npm install -g codeam-cli@latest` install. */
const CLI_UPDATE_INSTALL_TIMEOUT_MS = 180_000;
/** Retry attempts for the npm install (covers transient registry blips). */
const CLI_UPDATE_MAX_ATTEMPTS = 3;

/**
 * Compute the npm invocation for the self-update so it lands in the SAME
 * prefix the running CLI executes from. A bare `npm install -g` resolves
 * npm from the daemon's PATH and installs into the SYSTEM prefix — on a
 * codespace the daemon runs from the bootstrap prefix
 * `/tmp/codeam-node20/...`, so the update landed elsewhere, the re-exec
 * relaunched the OLD binary, and the session reconnected still-outdated
 * (the "Some sessions may need a manual update" 90 s fallback,
 * 2026-07-04). DI'd for tests.
 */
export function buildNpmInstallInvocation(opts?: {
  entryScript?: string;
  execPath?: string;
  existsSync?: (p: string) => boolean;
  /**
   * Prepend `sudo -n` (non-interactive). Used as the retry when the plain
   * install hits EACCES: a self-hosted box installs the global CLI via
   * `sudo npm i -g` (root-owned <prefix>/lib/node_modules), so the unprivileged
   * host-agent can't rename it on update. The enroll flow already established
   * passwordless sudo for this user, so `sudo -n` succeeds without a prompt.
   */
  sudo?: boolean;
  /**
   * Target OS. Defaults to the host (`process.platform`). DI'd ONLY so the
   * tests can exercise BOTH the POSIX and the win32 path/npm-name resolution
   * deterministically on any CI runner (a Windows leg no longer needs the
   * POSIX cases skipped, nor vice-versa) — production always uses the default.
   */
  platform?: NodeJS.Platform;
}): { command: string; args: string[] } {
  const entryScript = opts?.entryScript ?? process.argv[1] ?? '';
  const execPath = opts?.execPath ?? process.execPath;
  const exists = opts?.existsSync ?? fs.existsSync;
  const platform = opts?.platform ?? process.platform;
  // Resolve paths with the module matching the TARGET platform (not the host
  // running this code) so behavior — and the tests — are identical on every OS.
  const p = platform === 'win32' ? path.win32 : path.posix;

  // Global npm layout: <prefix>/lib/node_modules/codeam-cli/... → target
  // that prefix explicitly so the running install is replaced in place.
  // Split on EITHER separator so a win32 entryScript is handled off-host too.
  const normalized = entryScript.split(/[\\/]/).join('/');
  const marker = '/lib/node_modules/codeam-cli/';
  const markerIdx = normalized.indexOf(marker);
  const prefix = markerIdx > 0 ? entryScript.slice(0, markerIdx) : null;

  // Prefer the npm sibling of the running node — the detached daemon may
  // have no npm on PATH at all (codespace: /tmp/codeam-node20/bin/npm).
  const siblingNpm = p.join(
    p.dirname(execPath),
    platform === 'win32' ? 'npm.cmd' : 'npm',
  );
  const npmCommand = exists(siblingNpm) ? siblingNpm : 'npm';

  const npmArgs = prefix
    ? ['install', '-g', '--prefix', prefix, 'codeam-cli@latest']
    : ['install', '-g', 'codeam-cli@latest'];

  // sudo runs npm from root's PATH, which may not include the sibling node's
  // bin — pass the resolved npm path through explicitly so the right npm runs.
  if (opts?.sudo) {
    return { command: 'sudo', args: ['-n', npmCommand, ...npmArgs] };
  }
  return { command: npmCommand, args: npmArgs };
}

/** EACCES / permission-denied from an npm global write against a root-owned prefix. */
export function isPermissionError(stderr: string): boolean {
  return /EACCES|permission denied|errno[\s"']*-13|operation not permitted/i.test(stderr);
}

/**
 * Resolve the global `node_modules` dir the running CLI installs into, so we
 * can sweep leftover npm staging dirs before an update. Mirrors the prefix
 * logic in {@link buildNpmInstallInvocation}. Returns null when the layout
 * doesn't match (win32 has no `/lib/` segment; a dev checkout isn't global) —
 * the sweep is then skipped, never fatal. DI'd for tests.
 */
export function resolveGlobalNodeModulesDir(opts?: {
  entryScript?: string;
  platform?: NodeJS.Platform;
}): string | null {
  const entryScript = opts?.entryScript ?? process.argv[1] ?? '';
  const platform = opts?.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const marker = '/lib/node_modules/codeam-cli/';
  const markerIdx = entryScript.split(/[\\/]/).join('/').indexOf(marker);
  if (markerIdx <= 0) return null;
  const prefix = entryScript.slice(0, markerIdx);
  return p.join(prefix, 'lib', 'node_modules');
}

/**
 * A staging dir older than the longest possible install cannot belong to a
 * live install, so it's safe to remove. Keeps the sweep from ever disturbing a
 * concurrent in-flight sibling install's freshly-created staging dir.
 */
const STALE_STAGING_AGE_MS = CLI_UPDATE_INSTALL_TIMEOUT_MS;

/**
 * Sweep leftover npm staging dirs (`.codeam-cli-<hash>`) that a crashed or
 * concurrent global install left behind in `node_modules`. On update npm
 * renames the CURRENT package INTO one of these; a stale leftover makes that
 * rename fail with `ENOTEMPTY` and permanently wedges the self-update — even
 * the "Retry" button keeps hitting it (Rafael 2026-07-27: three pair-auto
 * children of one warm codespace fired concurrent `npm i -g` that raced on the
 * shared `/usr/local` prefix, and the wreckage blocked every retry). Only
 * removes entries OLDER than {@link STALE_STAGING_AGE_MS} so an in-flight
 * sibling install is never touched. Best-effort — never throws; returns the
 * count removed (for tests/logging).
 */
export function sweepStaleCliStagingDirs(
  nodeModulesDir: string | null,
  now: number = Date.now(),
  deps?: {
    readdirSync?: typeof fs.readdirSync;
    statSync?: typeof fs.statSync;
    rmSync?: typeof fs.rmSync;
  },
): number {
  if (!nodeModulesDir) return 0;
  const readdirSync = deps?.readdirSync ?? fs.readdirSync;
  const statSync = deps?.statSync ?? fs.statSync;
  const rmSync = deps?.rmSync ?? fs.rmSync;
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(nodeModulesDir) as string[];
  } catch {
    return 0; // node_modules unreadable — nothing to sweep.
  }
  for (const name of entries) {
    // npm's global staging/trash dirs for this package: `.codeam-cli-<hash>`.
    if (!/^\.codeam-cli-/.test(name)) continue;
    const full = path.join(nodeModulesDir, name);
    try {
      const st = statSync(full);
      if (now - st.mtimeMs < STALE_STAGING_AGE_MS) continue; // possibly in-flight
      rmSync(full, { recursive: true, force: true });
      removed++;
    } catch {
      /* best-effort — a racing rm or permission blip must not fail the update */
    }
  }
  return removed;
}

/**
 * Run `npm install -g codeam-cli@latest` (targeted at the running
 * install's prefix — see {@link buildNpmInstallInvocation}), retrying up
 * to {@link CLI_UPDATE_MAX_ATTEMPTS} times with exponential back-off.
 * Resolves `{ ok, error? }` — never rejects.
 */
export async function runNpmInstallLatest(): Promise<{ ok: boolean; error?: string }> {
  // Clear any stale `.codeam-cli-<hash>` staging dir a prior crashed/concurrent
  // install left in the global node_modules — npm renames the current package
  // into one on update, and a leftover makes that rename fail ENOTEMPTY and
  // wedges every retry (Rafael 2026-07-27). Best-effort + stale-age-gated so an
  // in-flight sibling is never touched.
  try {
    const swept = sweepStaleCliStagingDirs(resolveGlobalNodeModulesDir());
    if (swept > 0) {
      log.info('cli-update', `cleared ${swept} stale npm staging dir(s) before install`);
    }
  } catch {
    /* never let the pre-clean fail the update */
  }

  let lastError = '';
  // Escalates to `sudo -n` after a permission failure (self-hosted box whose
  // global prefix is root-owned from the `sudo npm i -g` enroll install).
  let useSudo = false;
  for (let attempt = 1; attempt <= CLI_UPDATE_MAX_ATTEMPTS; attempt++) {
    const invocation = buildNpmInstallInvocation({ sudo: useSudo });
    // Windows: npm resolves to a .cmd shim (npm.cmd), and patched Node
    // (CVE-2024-27980, >=18.20.2/20.12.2) refuses to spawn .cmd/.bat without
    // a shell — execFile throws EINVAL and self-update never runs. A shell is
    // safe here: the args are fixed tokens and Windows layouts never get a
    // --prefix (buildNpmInstallInvocation's /lib/node_modules marker cannot
    // match a win32 path — pinned by cli-update-install-target tests). The
    // command path itself may contain spaces (C:\Program Files\nodejs\npm.cmd)
    // so it must be quoted for cmd.exe. (sudo never runs on win32.)
    const useShell = process.platform === 'win32';
    const command =
      useShell && invocation.command.includes(' ')
        ? `"${invocation.command}"`
        : invocation.command;
    const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      execFile(
        command,
        invocation.args,
        { timeout: CLI_UPDATE_INSTALL_TIMEOUT_MS, shell: useShell },
        (err, _stdout, stderr) => {
          if (!err) {
            resolve({ ok: true });
          } else {
            resolve({ ok: false, error: (stderr || err.message).slice(0, 300) });
          }
        },
      );
    });
    if (result.ok) return { ok: true };
    lastError = result.error ?? 'unknown';
    // A root-owned global prefix (the `sudo npm i -g` enroll install) can't be
    // renamed by the unprivileged host-agent → EACCES. Escalate to `sudo -n`
    // for the remaining attempts (passwordless sudo established at enroll) and
    // retry immediately — it's a different command, not a transient blip.
    if (!useSudo && process.platform !== 'win32' && isPermissionError(lastError)) {
      useSudo = true;
      continue;
    }
    if (attempt < CLI_UPDATE_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 1_000 * attempt));
    }
  }
  return { ok: false, error: lastError };
}

/**
 * `cli_self_update` relay handler.
 *
 * The backend pushes this command to outdated CLI sessions. The handler:
 *   1. Reports `phase:'updating'` to the backend (best-effort).
 *   2. Runs `npm install -g codeam-cli@latest` (with retry).
 *   3a. On failure → reports `phase:'failed'` + sendResult `{updated:false}`.
 *   3b. On success → reports `phase:'relaunching'` + sendResult `{updated:true}`
 *       + delegates to the injected `relaunch` seam (supervised: no-op exit;
 *       local: detached re-exec + process.exit(0)).
 *
 * The relaunch seam is injected via `deps` so tests can assert the DECISION
 * without actually killing the test process.
 */
export const cliSelfUpdateH = (
  deps: CliUpdateDeps = defaultCliUpdateDeps,
): CommandHandler =>
  async (ctx, cmd) => {
    // Best-effort progress report — never let a POST failure block the update.
    const report = async (phase: 'updating' | 'relaunching' | 'failed', error?: string) => {
      if (!ctx.pluginAuthToken) return;
      try {
        await postCliUpdateEvent({
          sessionId: ctx.sessionId,
          pluginId: ctx.pluginId,
          pluginAuthToken: ctx.pluginAuthToken,
          phase,
          error,
        });
      } catch { /* best-effort */ }
    };

    await report('updating');

    const result = await deps.install();

    if (!result.ok) {
      await report('failed', result.error?.slice(0, 200));
      await ctx.relay.sendResult(cmd.id, 'completed', { updated: false });
      return;
    }

    await report('relaunching');
    await ctx.relay.sendResult(cmd.id, 'completed', { updated: true });

    if (deps.isSupervised()) {
      // The HostAgentSupervisor does NOT auto-restart children on exit (confirmed:
      // proc.once('exit') in host-agent.ts only removes the map entry + fires
      // reportSessionEvent — no respawn). Exiting here would orphan the session.
      // The updated binary is on disk; it applies on the next natural restart.
      log.info('cli-update', 'supervised context — update installed, applies on next restart');
      return;
    }

    // Local codeam start: re-exec a fresh process from the updated global binary.
    // process.argv[1] is the CLI entry script (e.g. /usr/local/lib/node_modules/codeam-cli/dist/index.js).
    // We pass the original args (process.argv.slice(2)) so the session restarts with the same flags.
    const origArgs = process.argv.slice(2);
    log.info('cli-update', `re-execing ${process.argv[1]} with args: ${origArgs.join(' ')}`);
    deps.relaunch(origArgs);
  };

// ─── Terminal ─────────────────────────────────────────────────────

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
  await ctx.relay.sendResult(cmd.id, 'completed', result);
};

// Epic B follow-up — backend pushes this when the user clicks
// APPROVE_CHANGES / REJECT_CHANGES on a file in the diff drawer.
// `approved` → `git add <filePath>`. `rejected` → `git restore
// <filePath>` (discards every worktree edit on the file, not just
// the rejected hunks — drawer surfaces a confirm dialog before
// firing).
const applyFileReviewH: CommandHandler = async (ctx, cmd, parsed) => {
  const reviewAction = parsed.action === 'approved' || parsed.action === 'rejected'
    ? parsed.action
    : undefined;
  if (!parsed.filePath || !reviewAction) {
    await ctx.relay.sendResult(cmd.id, 'failed', {
      error: 'Missing filePath or action',
    });
    return;
  }
  const result = await applyFileReview(
    process.cwd(),
    parsed.filePath,
    reviewAction,
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
  // factory takes `claude`) via the shared normalizer. Other ids are
  // identical across both; unknown ids come back null.
  const internalId = normalizeAgentId(publicId);
  if (!internalId || !AGENT_REGISTRY[internalId].enabled) {
    log.trace('auto-link', `unknown / disabled agent: ${publicId}`);
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
      // This handler ALWAYS rides the user's real paired session (the
      // backend pushed the request onto it), never a `codeam link`
      // throwaway. Omitting the flag made the backend delete the
      // session the user had just paired (2026-07-02 incident) — the
      // backend now also guards via its own auto-link Redis flag, but
      // the CLI must state the truth for older backends too.
      preserveSession: true,
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
      type: USER_EVENTS.PREVIEW_ERROR,
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
        type: USER_EVENTS.PREVIEW_DETECTION_READY,
        payload: { detection: fromFile },
      });
      return;
    }

    void postPreviewEvent({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken,
      type: USER_EVENTS.PREVIEW_DETECTION_PENDING,
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
        type: USER_EVENTS.PREVIEW_ERROR,
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
        type: USER_EVENTS.PREVIEW_ERROR,
        payload: {
          stage: 'unsupported',
          message: detection.notes ?? 'No dev server applies to this project.',
        },
      });
      return;
    }
    log.info('preview', `detect: ${detection.framework} on :${detection.port} (took ${tookMs}ms)`);
    // Persist the result so the next detect (this session, a reconnect, or a
    // teammate) is instant. Only the prewarm cached `.codeam/preview.json`
    // before — so when the prewarm didn't run (e.g. it raced agent startup),
    // every detect paid the full 30-90 s LLM round-trip again. Best-effort.
    void writePreviewConfig(process.cwd(), detection).catch((err) => {
      log.info('preview', `detect: writePreviewConfig failed (non-fatal): ${String(err)}`);
    });
    void postPreviewEvent({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken,
      type: USER_EVENTS.PREVIEW_DETECTION_READY,
      payload: { detection },
    });
  })();
};

let previewPrewarmStarted = false;

/**
 * Proactively run project-type detection ONCE after the session is up and
 * cache it to `.codeam/preview.json`, so the user's FIRST "Start Preview"
 * skips the ~50 s "Detecting project…" step and lands straight on the
 * confirm sheet (the on-demand `request_preview_detect` handler then reads
 * the cache instead of invoking the agent).
 *
 * Uses the SAME headless `claude -p` one-shot the on-demand path uses — a
 * separate short-lived child process, safe alongside the live interactive
 * session (the agent runtime's `generateOneShot` already runs this way for
 * AI summaries). Idempotent (cache + once-guard) and strictly non-fatal:
 * a failure just means the first preview pays the detect cost, as today.
 */
export function prewarmPreviewDetection(runtime: RuntimeStrategy): void {
  if (previewPrewarmStarted) return;
  previewPrewarmStarted = true;
  if (typeof runtime.generateOneShot !== 'function') return;
  void (async () => {
    try {
      const cwd = process.cwd();
      if (await readPreviewConfig(cwd)) return; // already pinned/cached — nothing to do
      const raw = await runtime.generateOneShot!(PREVIEW_DETECT_PROMPT).catch(() => null);
      const detection = safeParseDetection(raw);
      if (!detection || detection.framework === 'unsupported') return;
      await writePreviewConfig(cwd, detection);
      log.info(
        'preview',
        `prewarm: cached detection (${detection.framework} on :${detection.port})`,
      );
    } catch (err) {
      log.info('preview', `prewarm: skipped (${String(err)})`);
    }
  })();
}

// The staged preview bring-up pipeline (provisionDeps -> startDevServer ->
// establishTunnel) lives in `services/preview/start-orchestrator.ts`. The
// readiness/normalize helpers moved there with it; re-exported here so
// existing importers and tests keep their `commands/start/handlers` path.
export {
  compileReadyPattern,
  normalizeDetectionForSpawn,
  waitForDevServerReady,
  type ChildProcessWithIO,
  type ReadyOutcome,
} from '../../services/preview/start-orchestrator';

const previewStartH: CommandHandler = (ctx, _cmd, parsed) => {
  if (!ctx.pluginAuthToken) {
    log.info('preview', 'no pluginAuthToken — skipping start');
    return;
  }
  const rawDetection = parsed.detection as PreviewDetection | undefined;
  if (!rawDetection) {
    log.info('preview', 'start: no detection in payload');
    return;
  }
  // NOTE: the `npx <bin>` → `./node_modules/.bin/<bin>` rewrite runs
  // AFTER the pre-flight `pnpm/npm install` step so the local binary
  // actually exists when we test for it. Running it here at the top
  // — when node_modules may not exist yet on a fresh codespace —
  // silently no-ops and we'd spawn through the unreliable npx wrapper.
  startPreviewFromDetection(ctx, rawDetection, ctx.pluginAuthToken);
};

/**
 * Fire-and-forget bring-up of a preview from a detection: runs setup
 * commands, spawns the dev server, waits for readiness, opens the tunnel,
 * registers the ActivePreview, and emits the preview_* lifecycle events.
 * Shared by previewStartH (first start) and previewRestartH (env reload).
 *
 * The staged pipeline itself lives in
 * `services/preview/start-orchestrator.ts` (`runPreviewStart`). This
 * wrapper owns the transport: ONE `emit` closure over `postPreviewEvent`
 * (payloads/order identical to the pre-extraction inline body) plus the
 * safety net for unexpected throws.
 */
export function startPreviewFromDetection(
  ctx: HandlerContext,
  detection: PreviewDetection,
  pluginAuthToken: string,
): void {
  const emit: EmitPreviewEvent = (type, payload) => {
    void postPreviewEvent({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken,
      type,
      payload,
    });
  };
  runPreviewStart({
    sessionId: ctx.sessionId,
    detection,
    cwd: process.cwd(),
    emit,
    // Auth for the per-repo `.env` vault restore, performed INSIDE the bring-up
    // (provisionDeps stage, after the reuse short-circuit) so a fresh session of
    // this repo picks up its saved `.env` before the dev server spawns. Optional
    // — a caller without a token just skips the restore.
    projectEnvAuth: { pluginId: ctx.pluginId, pluginAuthToken },
  })
    .then(() => maybeAttachBuildHeal(ctx, pluginAuthToken))
    .catch((err) => {
      // Safety net: any UNEXPECTED throw in the detached bring-up (a malformed
      // detection field, a parser bug, etc.) must NOT become a silent unhandled
      // rejection that leaves the mobile preview on a black screen forever.
      // Surface it as a preview_error so the UI can show something actionable.
      const message = err instanceof Error ? err.message : String(err);
      log.warn('preview', `start crashed before ready: ${message}`);
      emit(USER_EVENTS.PREVIEW_ERROR, {
        stage: 'spawn',
        message: `Preview failed to start: ${message}`,
      });
    });
}

/**
 * Arms the Next.js build-clobber self-heal (`services/preview/build-heal.ts`)
 * for a preview that just finished bring-up. Called after EVERY
 * `startPreviewFromDetection` resolution — the initial `preview_start`, a
 * `preview_restart` (env-var reload), and a heal-triggered restart all funnel
 * through here, which is what re-arms the watcher across a heal restart's
 * kill+respawn cycle (the restart-count cap itself lives outside the watcher
 * instance, in `build-heal.ts`, so it survives that recreation intact).
 *
 * No-ops when: bring-up didn't register a preview (it ended in
 * `preview_error`, or `.catch()` above is about to fire instead), the
 * framework isn't Next.js, or this preview instance already has a watcher
 * (the `runPreviewStart` reuse-guard resolved without touching the existing
 * `ActivePreview`, whose watcher is already live).
 */
export function maybeAttachBuildHeal(ctx: HandlerContext, pluginAuthToken: string): void {
  const preview = previewSvc.activePreviews.get(ctx.sessionId);
  if (!preview || preview.buildHealStop) return;
  if (!previewSvc.isBuildHealSupported(preview.framework)) return;
  const { stop } = previewSvc.watchForBuildClobber({
    cwd: preview.cwd,
    sessionId: ctx.sessionId,
    restart: () => {
      void (async () => {
        // ⚠️ A stopped preview must NEVER come back. This closure is async and
        // sleeps between the kill and the respawn, so a user stop (or any
        // other teardown) can land inside that window — and `killPreview`
        // below also runs while the caller may already have torn things down.
        // Without re-checking, self-healing resurrects a preview the user
        // deliberately stopped, which is worse than the bug it fixes.
        //
        // Caught by CI on Linux, not on macOS: `fs.watch` delivery timing
        // differs enough that the race only lost there. The guard makes the
        // outcome independent of that timing.
        //
        // Only ONE check, and it goes BEFORE the kill. A second check after
        // the wait looks symmetric but is wrong: `killPreview` deregisters the
        // session, so re-testing presence there blocks the very restart this
        // exists to perform.
        if (!previewSvc.activePreviews.has(ctx.sessionId)) return;
        await previewSvc.killPreview(ctx.sessionId);
        // 150 ms so the port is fully released before the fresh spawn binds
        // it — same grace period `previewRestartH` waits below.
        await new Promise((r) => setTimeout(r, 150));
        self.startPreviewFromDetection(ctx, preview.detection, pluginAuthToken);
      })();
    },
    notify: (message) => {
      void postPreviewEvent({
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        pluginAuthToken,
        type: USER_EVENTS.PREVIEW_PROGRESS,
        payload: { step: 'BUILD_HEAL', message, timestamp: Date.now() },
      });
    },
  });
  preview.buildHealStop = stop;
}

const previewStopH: CommandHandler = (ctx) => {
  if (!ctx.pluginAuthToken) {
    log.info('preview', 'no pluginAuthToken — skipping stop');
    return;
  }
  const pluginAuthToken = ctx.pluginAuthToken;
  void (async () => {
    await killPreview(ctx.sessionId);
    // A genuine user stop, not a heal-triggered restart — clear the
    // build-heal restart cap so a later fresh preview for this session
    // isn't penalized by rebuilds that happened during a previous run.
    previewSvc.resetBuildHealState(ctx.sessionId);
    log.info('preview', `stopped session=${ctx.sessionId}`);
    void postPreviewEvent({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken,
      type: USER_EVENTS.PREVIEW_STOPPED,
      payload: { reason: 'user' },
    });
  })();
};

// Mobile/web "Restart preview" — used after an env-var edit so the dev
// server reloads with the new `.env`. Kills the running preview, waits a
// beat for the OS to release the port, then re-spawns from the SAME stored
// detection (no re-detection round-trip). No-ops with `restarted:false` when
// there's nothing running or the session predates pluginAuthToken.
//
// `killPreview` is called through `previewSvc.*` and `startPreviewFromDetection`
// through `self.*` so both are interceptable by a namespace spy in the unit
// test — see the `import * as self` note at the top of this file.
const previewRestartH: CommandHandler = async (ctx, cmd) => {
  if (!ctx.pluginAuthToken) {
    await ctx.relay.sendResult(cmd.id, 'completed', { restarted: false });
    return;
  }
  const preview = activePreviews.get(ctx.sessionId);
  if (!preview) {
    await ctx.relay.sendResult(cmd.id, 'completed', { restarted: false });
    return;
  }
  await previewSvc.killPreview(ctx.sessionId);
  // 150 ms so the port is fully released before the fresh spawn binds it.
  await new Promise((r) => setTimeout(r, 150));
  self.startPreviewFromDetection(ctx, preview.detection, ctx.pluginAuthToken);
  await ctx.relay.sendResult(cmd.id, 'completed', { restarted: true });
};

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

/**
 * Native ACP guardrails — read or update this session's policy live.
 *  - `{action:'read'}`  → returns the current policy (default-on if none set).
 *  - `{action:'write', policy}` → normalizes + persists (~/.codeam/guardrails.json)
 *    + updates the in-memory policy the runner/client read; returns the applied
 *    policy. Untrusted input is coerced by `normalizeGuardrailPolicy`.
 * Agnostic to agent/plan — safety is free and applies to every managed session.
 */
const guardrailConfigureH: CommandHandler = async (ctx, cmd) => {
  const payload = cmd.payload as { action?: 'read' | 'write'; policy?: unknown } | undefined;
  if (payload?.action === 'write') {
    const policy = setGuardrailPolicy(payload.policy);
    await ctx.relay.sendResult(cmd.id, 'completed', { policy });
    return;
  }
  await ctx.relay.sendResult(cmd.id, 'completed', { policy: getGuardrailPolicy() });
};

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
  show_install_command: showInstallCommand,
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
  preview_restart: previewRestartH,
  save_preview_config: savePreviewConfigH,
  env_read: envReadH,
  env_write: envWriteH,
  skills_configure: skillsConfigureH,
  take_control: takeControlH,
  handback: handbackH,
  headroom_configure: headroomConfigureH,
  headroom_usage: headroomUsageH,
  coderabbit_configure: coderabbitConfigureH,
  vcs_agent_review: vcsAgentReviewH,
  headroom_budget: headroomBudgetH,
  beads_configure: beadsConfigureH,
  guardrail_configure: guardrailConfigureH,
  cli_self_update: cliSelfUpdateH(),
};

/**
 * Dispatcher entry point — called by the relay's onCommand
 * callback. Validates the command's payload against the shared
 * Zod schema, looks up the handler by command type, and lets it
 * execute. Unknown / malformed commands are logged and dropped
 * so a misbehaving server can't crash the CLI.
 */
export async function dispatchCommand(
  ctx: BaseHandlerContext,
  cmd: RemoteCommand,
): Promise<void> {
  // Beads actions carry a `{action, args}` shape that intentionally
  // doesn't fit `startCommandSchema` (its `action` is the file-review
  // enum). Intercept before the generic parse and replay the action as
  // a native `bd` command via the orchestrator. Strictly non-fatal:
  // any beads failure is swallowed so a misbehaving action can't break
  // the relay's sequential dispatch loop.
  if (cmd.type === 'beads_action') {
    if (!ctx.beads) {
      log.trace('beads', 'beads_action received but beads not running this session — dropping');
      return;
    }
    const action = beadsActionFromPayload(cmd.payload);
    if (!action) {
      log.warn('beads', 'malformed beads_action payload — dropping');
      return;
    }
    try {
      await handleBeadsActionCommand(action, ctx.beads);
    } catch (err) {
      log.warn('beads', 'handleBeadsActionCommand failed (non-fatal)', err);
    }
    return;
  }

  const parsed = parsePayload(startCommandSchema, cmd.payload);
  if (!parsed) {
    showInfo(`Ignoring malformed ${cmd.type} payload.`);
    return;
  }
  const handler = handlers[cmd.type];
  if (!handler) return;
  // Widen Base → full PTY context at this single boundary. The registry is
  // typed against the full HandlerContext because SOME handlers (start_task,
  // provide_input, …) dereference the PTY fields — but those are only ever
  // dispatched from the PTY `start()` path, which always passes a full context.
  // Callers with only a Base context (the ACP session runner, the no-agent
  // infra-only path) reach exclusively agent-agnostic handlers that read only
  // Base fields, so the widening is sound. This replaces the `as unknown as`
  // casts the ACP/infra-only builders previously used to fabricate PTY fields.
  await handler(ctx as HandlerContext, cmd, parsed);
}
