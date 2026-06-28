import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import which from 'which';
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
import { postLinkCredential, postAiResult, postPreviewEvent, postHeadroomEvent, postBeadsEvent } from '../../services/pairing.service';
import {
  agentIdToHeadroomKind,
  isHeadroomSupportedAgent,
  persistHeadroomConfig,
  headroomConfigPath,
  restoreAgentHeadroomConfig,
  setupHeadroomForSelfHosted,
} from '../../commands/host-agent';
import { configureHeadroom } from '../../services/headroom/configure';
import { HeadroomStatsReporter, mapStatsToSavings, type StatsShape, type Savings } from '../../services/headroom/stats-reporter';
import { AGENT_REGISTRY, isKnownAgentId, PREVIEW_DETECT_PROMPT, type AgentId, type PreviewDetection } from '@codeagent/shared';
import * as previewSvc from '../../services/preview';
import {
  activePreviews,
  detectMissingNodeDeps,
  ensureYarnInstalled,
  isJsInstallCommand,
  isPortListening,
  killPreview,
  killProcessTree,
  parseDotenv,
  serializeDotenv,
  ENV_KEY_RE,
  parseCloudflaredUrl,
  parseExpoUrl,
  readPreviewConfig,
  registerPreview,
  resolveCloudflared,
  spawnNamedTunnel,
  runSetupCommand,
  safeParseDetection,
  waitForPortListening,
  writePreviewConfig,
} from '../../services/preview';
import { log } from '../../services/logger';
import type { KeepAliveContext } from './keep-alive';
import { removeSession } from '../../config';
import { handleBeadsActionCommand, type StartedBeads, startBeads } from '../../beads';
import { beadsActionFromPayload } from '../../beads/wiring';
import { configureBeads, probeBeadsStatus, type ConfigureBeadsDeps } from '../../beads/configure';
import { persistBeadsConfig, readBeadsEnabled } from '../../beads/config-store';
import { provisionBeads } from '../../beads/provisioner';
import type { BeadsConfigureAction } from '@codeagent/shared';
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
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
    await ctx.relay.sendResult(cmd.id, 'failed', { error: (err as Error).message });
  }
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
  // Normalize the common public-id alias (`claude_code` → `claude`) so the value
  // is consistent with what `requestLinkCredentialsH` writes.
  let rawAgentId = ctx.agentId || (typeof parsed.agentId === 'string' ? parsed.agentId : '');
  if (rawAgentId === 'claude_code') rawAgentId = 'claude';
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
        const res = await fetch('http://localhost:8787/stats');
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
          const res = await fetch('http://localhost:8787/stats');
          return res.json() as Promise<StatsShape>;
        },
        postSavings: async (delta: Savings) => {
          if (!opts.ingestUrl) return;
          await fetch(opts.ingestUrl, {
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
            }),
          });
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
    stopProxy: () => {
      try {
        const p = spawn('pkill', ['-TERM', '-f', 'headroom.*proxy'], {
          detached: true,
          stdio: 'ignore',
        });
        // `spawn` emits ENOENT (e.g. `pkill`/procps absent on a minimal box)
        // as an ASYNC 'error' event — the try/catch above only guards the
        // synchronous call. Without this handler the unhandled 'error'
        // crashes the process. Disable is best-effort, so swallow it.
        p.on('error', () => {});
        p.unref();
      } catch { /* no proxy running — best-effort */ }
    },
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
  if (rawAgentId === 'claude_code') rawAgentId = 'claude';

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
          type: 'beads_status',
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
      type: 'preview_detection_ready',
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

/**
 * `npx <binary>` is unreliable as a long-running spawn target. npm 11's
 * `npm exec` (the npx wrapper) fork-spawns the resolved binary and the
 * parent process can exit before the child is fully wired up — leaving
 * the dev server alive but orphaned (PPID 1) while the CLI's
 * `spawn(...)` handle reports `exitCode = 0` and bails out as if the
 * server crashed.
 *
 * Symptom: Mobile/landing's Preview card shows
 * `ERR_SPAWN_FAILED · Dev server exited (code 0)` even though
 * `ss -ltnp` confirms the port is bound and `curl` succeeds.
 *
 * Fix: when the agent returns `command: 'npx', args: [<bin>, …]` and
 * `./node_modules/.bin/<bin>` exists, rewrite the spawn target to the
 * direct binary path. Deterministic, no shell intermediate, no
 * lifecycle race. Falls through unchanged for npx-installed-on-demand
 * scenarios (binary not local), preserving the existing behavior for
 * tools like `cloudflared` that legitimately need npx.
 */
/**
 * Compile the agent's `ready_pattern` into a RegExp the spawn
 * watcher uses to detect "the dev server is up". Case-insensitive
 * on purpose: the detection prompt often produces lowercase patterns
 * like `"ready in"` while Next.js prints `Ready in` (capital R) and
 * Vite prints `ready in` (lowercase). A case mismatch is invisible
 * to the user, stalls the entire pipeline at WAITING_FOR_READY, and
 * surfaces as `ERR_READY_TIMEOUT` 120 s later. Most ready strings
 * are unambiguous enough that the looser match never
 * false-positives in practice.
 */
export function compileReadyPattern(pattern: string): RegExp {
  return new RegExp(pattern, 'i');
}

/**
 * Watch a freshly-spawned dev server's stdout+stderr for the
 * compiled `ready_pattern` regex. Resolves with the outcome instead
 * of throwing so the caller can map each terminal state to the
 * right `preview_error` payload without a try/catch.
 *
 * Slides a 32 KB window over recent output so a ready signal split
 * across multiple `data` chunks ("Read" + "y in 1.5s") still
 * matches. Cap keeps memory bounded; the real ready line always
 * lands within the first few seconds of output, well under it.
 *
 * Polls `exitCode` every 250 ms because the `'exit'` event fires
 * once and we need to bail mid-loop without racing — same cadence
 * the inline implementation used.
 */
export type ReadyOutcome =
  | { kind: 'ready' }
  | { kind: 'exited'; code: number | null }
  | { kind: 'timeout' };

export async function waitForDevServerReady(
  devServer: ChildProcessWithIO,
  readyRe: RegExp,
  opts: {
    timeoutMs: number;
    onChunk?: (chunk: string) => void;
    /**
     * Additive readiness fallback (BUG 1). The `readyRe` regex is the
     * PRIMARY signal; this probe only catches the cases it misses — a
     * server that's actually listening on its port but whose stdout
     * never trips the agent-supplied pattern (e.g. Next.js's
     * `▲ Next.js 14.x` / `- Local: http://...` lines). Resolve `true`
     * once the port is accepting connections. Polled in the same loop
     * as the regex; whichever fires first wins. Omit it (non-Next.js
     * frameworks where the regex is reliable) to keep the legacy
     * stdout-only behavior.
     */
    portProbe?: () => Promise<boolean>;
  } = {
    timeoutMs: 120_000,
  },
): Promise<ReadyOutcome> {
  let readyMatched = false;
  const READY_BUFFER_MAX = 32_768;
  let readyBuffer = '';
  const consume = (chunk: Buffer): void => {
    const s = chunk.toString();
    opts.onChunk?.(s);
    if (readyMatched) return;
    readyBuffer += s;
    if (readyBuffer.length > READY_BUFFER_MAX) {
      readyBuffer = readyBuffer.slice(-READY_BUFFER_MAX);
    }
    if (readyRe.test(readyBuffer)) readyMatched = true;
  };
  devServer.stdout?.on('data', consume);
  devServer.stderr?.on('data', consume);

  // Guard against overlapping probe calls when one connect attempt
  // outlasts the 250 ms poll tick.
  let probeInFlight = false;
  const deadline = Date.now() + opts.timeoutMs;
  while (!readyMatched && Date.now() < deadline) {
    if (devServer.exitCode !== null) {
      return { kind: 'exited', code: devServer.exitCode };
    }
    if (opts.portProbe && !probeInFlight) {
      probeInFlight = true;
      void opts
        .portProbe()
        .then((up) => {
          if (up) readyMatched = true;
        })
        .catch(() => {
          /* probe failures are non-fatal — the regex / deadline still apply */
        })
        .finally(() => {
          probeInFlight = false;
        });
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (readyMatched) return { kind: 'ready' };
  return { kind: 'timeout' };
}

/** Minimal child-process surface `waitForDevServerReady` reads. Keeps
 *  the helper testable with a real `child_process.spawn` result OR a
 *  hand-rolled stub. */
export interface ChildProcessWithIO {
  readonly exitCode: number | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
}

export function normalizeDetectionForSpawn(
  detection: PreviewDetection,
  cwd: string,
): PreviewDetection {
  // pnpm/bun can't run the dev server on the codespace runtime: pnpm ≥10
  // needs Node ≥22.13 (it imports node:sqlite) while codespaces ship Node 20,
  // and bun is often absent. The agent detection / saved `.codeam/preview.json`
  // may still carry `pnpm dev` (verified live: BOOT_SEQUENCE "pnpm dev" hung,
  // then ERR_SPAWN_FAILED). Rewrite the script run to npm — it always ships
  // with Node and reads the same package.json scripts. yarn is left alone
  // (yarn classic runs on Node 20). Only script runs are rewritten; one-off
  // binary fetches (`exec`/`dlx`/`x`) fall through unchanged.
  if (detection.command === 'pnpm' || detection.command === 'bun') {
    const raw = detection.args ?? [];
    const verb = raw[0];
    if (verb && !['exec', 'dlx', 'x'].includes(verb)) {
      const rest = verb === 'run' ? raw.slice(1) : raw;
      const [script, ...extra] = rest;
      if (script && !script.startsWith('-')) {
        // npm needs an explicit `--` before flags forwarded to the script;
        // pnpm/bun forward trailing args to the script implicitly.
        return {
          ...detection,
          command: 'npm',
          args: extra.length ? ['run', script, '--', ...extra] : ['run', script],
        };
      }
    }
  }
  if (detection.command !== 'npx') return detection;
  const args = detection.args ?? [];
  if (args.length === 0) return detection;
  const binName = args[0];
  if (binName.startsWith('-')) return detection;
  const binPath = path.join(cwd, 'node_modules', '.bin', binName);
  if (!fs.existsSync(binPath)) return detection;
  return {
    ...detection,
    command: binPath,
    args: args.slice(1),
  };
}

/**
 * Time budgets for the preview bring-up's blocking command steps
 * (BUG 1). Without these a stalled step — most commonly a fresh
 * codespace's `pnpm install` with no node_modules — wedges the whole
 * pipeline and the user waits on the spinner indefinitely.
 *
 * Installs get the generous budget (a cold monorepo install legitimately
 * runs into minutes); codegen / prebuild steps get the tighter one.
 */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const SETUP_TIMEOUT_MS = 2 * 60_000;

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
 */
export function startPreviewFromDetection(
  ctx: HandlerContext,
  detection: PreviewDetection,
  pluginAuthToken: string,
): void {
  /**
   * Fire-and-forget progress emitter — used by `previewStartH` to ship
   * one realtime milestone per step the dev-server bring-up traverses
   * (ENV_DETECTED → SETUP_RUN → BOOT_SEQUENCE → BIND_PORT →
   * WAITING_FOR_READY → READY_DETECTED → TUNNEL_STARTING →
   * TUNNEL_READY). The mobile + landing `PreviewStartingLog`
   * subscribes to these on the per-user SSE bus and renders the
   * HANDSHAKE_LOG card — replaces the previous bare-spinner UX with
   * the same realtime cadence the Codespace deploy wizard uses.
   *
   * Errors are swallowed: the dev server brings itself up regardless;
   * the progress log is best-effort UX, not load-bearing.
   */
  const emitProgress = (step: string, message: string): void => {
    void postPreviewEvent({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken,
      type: 'preview_progress',
      payload: { step, message, timestamp: Date.now() },
    });
  };

  void (async () => {
    // Reuse guard: if a dev server for this session is already running,
    // re-opening the preview must NOT re-spawn it on the same port
    // (that hits EADDRINUSE → ERR_SPAWN_FAILED "Port N already in use").
    const existing = activePreviews.get(ctx.sessionId);
    if (existing && existing.devServer.exitCode === null) {
      log.info(
        'preview',
        `reusing running preview for session=${ctx.sessionId} url=${existing.url}`,
      );
      emitProgress('READY_DETECTED', 'reusing running preview');
      void postPreviewEvent({
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        pluginAuthToken,
        type: 'preview_ready',
        payload: { url: existing.url, framework: existing.framework, port: detection.port },
      });
      return;
    }

    void postPreviewEvent({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken,
      type: 'preview_starting',
      payload: { framework: detection.framework, port: detection.port },
    });
    emitProgress('ENV_DETECTED', `${detection.framework}`);

    // 0. Pre-flight: install Node deps if `package.json` exists but
    //    `node_modules/` is missing. Safety net for when the agent's
    //    `setup_commands` doesn't include an install — the dev server
    //    would otherwise crash on first spawn with "Cannot find
    //    module …". Returns null (no-op) when deps already present;
    //    we trust an existing `node_modules/` rather than running a
    //    slow no-op install on every preview boot.
    const missingDeps = detectMissingNodeDeps(process.cwd());
    let preflightRan = false;
    if (missingDeps) {
      // yarn isn't guaranteed on a fresh GitHub codespace (node + npm only).
      // If the project uses yarn, install it on demand FIRST — otherwise the
      // pre-flight spawns `yarn install` → ENOENT → exit null →
      // ERR_SPAWN_FAILED "Dependency install failed (yarn install, exit null)"
      // (observed live on a yarn project). We install rather than fall back to
      // npm so the project's real package manager + yarn.lock are honoured.
      if (missingDeps.cmd === 'yarn') {
        const ensured = await ensureYarnInstalled({
          hasYarn: async () => Boolean(await which('yarn', { nothrow: true })),
          installYarn: async () => {
            emitProgress('SETUP_RUN', 'installing yarn (not found on PATH) — npm install -g yarn');
            const r = await runSetupCommand(
              'npm',
              ['install', '-g', 'yarn'],
              process.cwd(),
              detection.env,
              { timeoutMs: INSTALL_TIMEOUT_MS },
            );
            return { ok: r.status === 'ok', code: r.code };
          },
        });
        if (!ensured.ok) {
          void postPreviewEvent({
            sessionId: ctx.sessionId,
            pluginId: ctx.pluginId,
            pluginAuthToken,
            type: 'preview_error',
            payload: {
              stage: 'spawn',
              message: `This project uses yarn but yarn isn't installed, and installing it automatically failed (npm install -g yarn, exit ${ensured.code}). Install yarn in this environment and try the preview again.`,
            },
          });
          return;
        }
      }
      emitProgress(
        'SETUP_RUN',
        `${missingDeps.cmd} ${missingDeps.args.join(' ')} (pre-flight — node_modules missing)`,
      );
      const result = await runSetupCommand(
        missingDeps.cmd,
        missingDeps.args,
        process.cwd(),
        detection.env,
        { timeoutMs: INSTALL_TIMEOUT_MS },
      );
      if (result.status === 'timeout') {
        // The hang BUG 1 guards against: a fresh codespace with no
        // node_modules stalls the install → the dev server never
        // spawns → the user waits on the spinner forever. Bound it and
        // emit an error so mobile leaves the spinner.
        void postPreviewEvent({
          sessionId: ctx.sessionId,
          pluginId: ctx.pluginId,
          pluginAuthToken,
          type: 'preview_error',
          payload: {
            stage: 'ready_timeout',
            message: `Dependency install (${missingDeps.cmd} ${missingDeps.args.join(' ')}) didn't finish within ${Math.round(INSTALL_TIMEOUT_MS / 1000)}s and was stopped. Run it manually in this project, then try the preview again.`,
          },
        });
        return;
      }
      if (result.status === 'failed') {
        void postPreviewEvent({
          sessionId: ctx.sessionId,
          pluginId: ctx.pluginId,
          pluginAuthToken,
          type: 'preview_error',
          payload: {
            stage: 'spawn',
            message: `Dependency install failed (${missingDeps.cmd} ${missingDeps.args.join(' ')}, exit ${result.code}). Run it manually in this project and try again.`,
          },
        });
        return;
      }
      preflightRan = true;
    }

    // 1. Setup commands from the agent — but skip any install command
    //    when the pre-flight just installed deps. The agent
    //    occasionally emits `npm install` for a pnpm-lock project (or
    //    vice versa) and running a second install with a different
    //    package manager on top of a just-populated `node_modules/`
    //    crashes — pnpm's `.pnpm/` symlinked layout breaks npm's tree
    //    resolver and npm errors out after ~3 min of ERESOLVE warnings
    //    (observed in prod with `Cannot read properties of null
    //    (reading 'matches')`). Lockfile-based pre-flight detection is
    //    authoritative — the agent's install is at best redundant, at
    //    worst destructive. Non-install setup steps (`prisma generate`,
    //    `prebuild`, etc.) still run.
    // The agent emits setup_commands as either {cmd,args} objects OR bare
    // strings ("npx prisma generate") — the detection prompt's example never
    // pinned the entry shape, so both occur in the wild. Normalize to {cmd,args}
    // here so the loop below never does `undefined.join(...)` on a string entry,
    // which threw inside this detached IIFE → unhandled rejection → a SILENT
    // black-screen preview (observed live on a Prisma/Next.js project whose
    // setup_commands was ["npx prisma generate"]).
    const normalizedSetup = ((detection.setup_commands ?? []) as Array<unknown>)
      .map((entry) => {
        if (typeof entry === 'string') {
          const parts = entry.trim().split(/\s+/).filter(Boolean);
          return { cmd: parts[0] ?? '', args: parts.slice(1) };
        }
        const o = (entry ?? {}) as { cmd?: unknown; args?: unknown };
        return {
          cmd: typeof o.cmd === 'string' ? o.cmd : '',
          args: Array.isArray(o.args)
            ? o.args.filter((a): a is string => typeof a === 'string')
            : [],
        };
      })
      .filter((s) => s.cmd.length > 0);
    const agentSetupCommands = preflightRan
      ? normalizedSetup.filter((s) => !isJsInstallCommand(s.cmd, s.args))
      : normalizedSetup;
    for (const setup of agentSetupCommands) {
      emitProgress('SETUP_RUN', `${setup.cmd} ${setup.args.join(' ')}`);
      // An install command (the agent may emit one for a project the
      // pre-flight didn't cover) gets the generous install budget; a
      // codegen/prebuild step gets the tighter one.
      const timeoutMs = isJsInstallCommand(setup.cmd, setup.args)
        ? INSTALL_TIMEOUT_MS
        : SETUP_TIMEOUT_MS;
      const result = await runSetupCommand(
        setup.cmd,
        setup.args,
        process.cwd(),
        detection.env,
        { timeoutMs },
      );
      if (result.status === 'timeout') {
        void postPreviewEvent({
          sessionId: ctx.sessionId,
          pluginId: ctx.pluginId,
          pluginAuthToken,
          type: 'preview_error',
          payload: {
            stage: 'ready_timeout',
            message: `Setup step (${setup.cmd} ${setup.args.join(' ')}) didn't finish within ${Math.round(timeoutMs / 1000)}s and was stopped.`,
          },
        });
        return;
      }
      if (result.status === 'failed') {
        void postPreviewEvent({
          sessionId: ctx.sessionId,
          pluginId: ctx.pluginId,
          pluginAuthToken,
          type: 'preview_error',
          payload: {
            stage: 'spawn',
            message: `Setup failed (${setup.cmd} ${setup.args.join(' ')}, exit ${result.code}).`,
          },
        });
        return;
      }
    }

    // 2. Spawn the dev server.
    //    Rewrite `npx <bin>` to the direct binary path NOW (after
    //    the optional pre-flight install) — `node_modules/.bin/<bin>`
    //    is guaranteed to exist by this point if it's going to exist
    //    at all. See `normalizeDetectionForSpawn` for why bypassing
    //    npx matters: npm 11's `npm exec` fork-exec's the underlying
    //    binary and the parent dies with exitCode=0 while the child
    //    runs orphaned, fooling the spawn watcher into bailing
    //    immediately with ERR_SPAWN_FAILED.
    // Guard: the detected port must be FREE before we spawn. If something is
    // already listening on it (a stale process, another dev server, a leftover
    // from a prior run), our dev server can't bind it AND — worse — the tunnel
    // forwards to that squatter, serving someone else's content under the
    // preview URL (observed live: a leftover `http.server` on :3000 served a
    // /tmp directory listing through the tunnel). Fail fast with an actionable
    // error instead of tunnelling the wrong process.
    if (await isPortListening(detection.port)) {
      // Race-condition safety: if the port is already ours (a live devServer
      // registered in activePreviews for this session), treat it as a reuse
      // rather than an error — a second preview_start arrived while our server
      // was already up (or the top-of-IIFE guard above was bypassed because
      // exitCode had already been set by the time we checked it).
      const raceExisting = activePreviews.get(ctx.sessionId);
      if (raceExisting && raceExisting.devServer.exitCode === null) {
        log.info(
          'preview',
          `port race: reusing running preview for session=${ctx.sessionId} url=${raceExisting.url}`,
        );
        emitProgress('READY_DETECTED', 'reusing running preview');
        void postPreviewEvent({
          sessionId: ctx.sessionId,
          pluginId: ctx.pluginId,
          pluginAuthToken,
          type: 'preview_ready',
          payload: { url: raceExisting.url, framework: raceExisting.framework, port: detection.port },
        });
        return;
      }
      // The port is held by OUR OWN prior preview for this session whose
      // parent process has already exited (exitCode !== null) but whose
      // worker children are still bound to the port (orphaned). This is the
      // "re-spawn on a port the same process already holds" case: reclaim it
      // — group-kill the stale tree, drop the registry entry, and wait
      // (bounded) for the port to actually release — then fall through and
      // re-spawn cleanly instead of failing with EADDRINUSE.
      if (raceExisting) {
        log.info(
          'preview',
          `reclaiming stale preview holding port ${detection.port} for session=${ctx.sessionId} (exit=${raceExisting.devServer.exitCode})`,
        );
        await killPreview(ctx.sessionId);
        const freeDeadline = Date.now() + 4_000;
        while ((await isPortListening(detection.port)) && Date.now() < freeDeadline) {
          await new Promise((r) => setTimeout(r, 200));
        }
        if (await isPortListening(detection.port)) {
          // Our own teardown didn't free it in time — surface the actionable
          // error rather than spawn into a guaranteed EADDRINUSE.
          void postPreviewEvent({
            sessionId: ctx.sessionId,
            pluginId: ctx.pluginId,
            pluginAuthToken,
            type: 'preview_error',
            payload: {
              stage: 'spawn',
              message: `Port ${detection.port} is still in use after stopping the previous preview. Wait a moment and try again.`,
            },
          });
          return;
        }
        // Port freed — continue to the spawn below.
      } else {
        // A foreign process owns the port (not one of ours). Don't kill it —
        // fail fast with an actionable error.
        void postPreviewEvent({
          sessionId: ctx.sessionId,
          pluginId: ctx.pluginId,
          pluginAuthToken,
          type: 'preview_error',
          payload: {
            stage: 'spawn',
            message: `Port ${detection.port} is already in use by another process, so the dev server can't start there. Stop whatever is listening on port ${detection.port} and try the preview again.`,
          },
        });
        return;
      }
    }

    const spawnable = normalizeDetectionForSpawn(detection, process.cwd());
    emitProgress(
      'BOOT_SEQUENCE',
      `${spawnable.command} ${spawnable.args.join(' ')}`,
    );
    const devServer = spawn(spawnable.command, spawnable.args, {
      cwd: process.cwd(),
      env: { ...process.env, ...(spawnable.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX: lead a new process group so teardown can SIGTERM the whole
      // tree. Dev servers fork worker children that bind the port; killing
      // only the direct child orphans them and leaks the port, so the next
      // preview_start hits EADDRINUSE on a port we already hold. Group-kill
      // (killProcessTree) reaps the workers too. Windows has no process
      // groups — leave detached off there (direct kill is the only option).
      detached: process.platform !== 'win32',
    });
    emitProgress('BIND_PORT', String(detection.port));
    emitProgress('WAITING_FOR_READY', detection.ready_pattern);
    let expoUrl: string | null = null;
    // Bounded tail of the dev server's stdout+stderr so a `preview_failed`
    // event can carry the REAL reason the server never came up (e.g. an
    // "Unable to connect to the database" loop) instead of a black screen.
    let outputTail = '';
    const readyRe = compileReadyPattern(detection.ready_pattern);
    // Additive port-listening fallback (BUG 1) for the framework that
    // hit the hang in prod: Next.js prints `▲ Next.js 14.x` /
    // `- Local: http://localhost:3000` rather than a literal "ready"
    // line, so a slightly-off `ready_pattern` stalled WAITING_FOR_READY
    // for the full 120 s while the server was already listening. The
    // regex stays primary; the probe only catches its misses. Scoped to
    // Next.js (not Expo, whose true ready signal is its tunnel URL, nor
    // generic frameworks where the regex is reliable) to avoid flipping
    // ready before the real signal lands.
    const isNextJs = /next/i.test(detection.framework);
    const outcome = await waitForDevServerReady(devServer, readyRe, {
      timeoutMs: 120_000,
      onChunk: (s) => {
        // Keep a generous window: when a task runner (Nx, Turbo, npm
        // workspaces) fails a dependency task, the REAL error prints
        // BEFORE the terse summary line, so a small tail captures only
        // the unhelpful "N tasks failed · run with --verbose" footer.
        // 16 KB reliably includes the failing task's own stderr.
        outputTail = (outputTail + s).slice(-16_000);
        if (!expoUrl && detection.framework === 'Expo') {
          expoUrl = parseExpoUrl(s);
        }
      },
      portProbe: isNextJs
        ? () => waitForPortListening(detection.port, { timeoutMs: 1_000, intervalMs: 250 })
        : undefined,
    });
    if (outcome.kind === 'exited') {
      // The dev server's parent exited, but it may have fork-exec'd a
      // worker that's still bound to the port — group-kill reaps it so the
      // next preview_start doesn't hit EADDRINUSE on a port we leaked.
      killProcessTree(devServer, 'SIGTERM');
      void postPreviewEvent({
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        pluginAuthToken,
        type: 'preview_error',
        payload: {
          stage: 'spawn',
          message: `The dev server exited (code ${outcome.code}) before it was ready. It may need a database or other services.`,
          stderrTail: outputTail.slice(-8000),
        },
      });
      return;
    }
    if (outcome.kind === 'timeout') {
      killProcessTree(devServer, 'SIGTERM');
      void postPreviewEvent({
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        pluginAuthToken,
        type: 'preview_error',
        payload: {
          stage: 'ready_timeout',
          message: "The dev server didn't become ready in time. It may be stuck waiting on a database or other service.",
          stderrTail: outputTail.slice(-8000),
        },
      });
      return;
    }
    emitProgress('READY_DETECTED', `port ${detection.port}`);

    // 4. Tunnel — three branches per the user's session environment.
    emitProgress(
      'TUNNEL_STARTING',
      detection.framework === 'Expo'
        ? 'Expo (self-tunnelled)'
        : 'cloudflared quick tunnel',
    );
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
        killProcessTree(devServer, 'SIGTERM');
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
    } else {
      // ALWAYS a Cloudflare Quick Tunnel — the same public-URL path for
      // codespaces, self-hosted boxes, and local CLIs, so the preview
      // behaves identically everywhere. We deliberately do NOT use GitHub
      // Codespaces port-forwarding (it required CODESPACE_NAME, which the
      // detached CLI env doesn't carry, and split behaviour by environment).
      let bin: string;
      try {
        bin = await resolveCloudflared();
      } catch (e) {
        killProcessTree(devServer, 'SIGTERM');
        void postPreviewEvent({
          sessionId: ctx.sessionId,
          pluginId: ctx.pluginId,
          pluginAuthToken,
          type: 'preview_error',
          payload: { stage: 'tunnel', message: (e as Error).message },
        });
        return;
      }
      // Cloudflare Quick Tunnels occasionally fail to register or are slow
      // to propagate DNS (the user hit this as an intermittent
      // ERR_TUNNEL_FAILED that "worked on the Nth manual retry"). A FRESH
      // tunnel almost always succeeds, so we auto-retry the whole bring-up
      // (spawn → URL → DNS-ready) up to 3 times with a new connector +
      // hostname each attempt, instead of surfacing the first miss to the
      // user. Each attempt's cloudflared child is killed before the next so
      // we never leak orphaned connectors.
      const MAX_TUNNEL_ATTEMPTS = 3;
      let parsedUrl: string | null = null;
      let lastTunnelErr = 'cloudflared did not emit a URL within 45s';

      // Named tunnel FIRST when the backend provisioned one. It lives under
      // our own zone (*.preview.codeagent-mobile.com), which ISP/security
      // resolvers serve reliably — unlike *.trycloudflare.com, which ANTEL
      // (and many others) resolve only intermittently, the root cause of the
      // -1003 the user hit. Delivered via env for BOTH surfaces: the
      // codespace bootstrap exports it; the host-agent exports it into the
      // child. On ANY failure we fall through to the quick-tunnel loop below.
      const namedToken = process.env.PREVIEW_TUNNEL_TOKEN;
      const namedHostname = process.env.PREVIEW_TUNNEL_HOSTNAME;
      if (namedToken && namedHostname) {
        try {
          emitProgress('TUNNEL_STARTING', `named tunnel ${namedHostname}`);
          const candidate = await spawnNamedTunnel(bin, namedToken, detection.port);
          let registered = false;
          const onNamedChunk = (chunk: Buffer): void => {
            const s = chunk.toString();
            if (/Registered tunnel connection/i.test(s)) registered = true;
            const trimmed = s.replace(/\n+$/g, '');
            if (trimmed.length > 0) log.info('preview', `cloudflared: ${trimmed}`);
          };
          candidate.stderr!.on('data', onNamedChunk);
          candidate.stdout!.on('data', onNamedChunk);
          const namedDeadline = Date.now() + 45_000;
          while (!registered && Date.now() < namedDeadline) {
            await new Promise((r) => setTimeout(r, 250));
          }
          if (registered) {
            const namedUrl = `https://${namedHostname}`;
            log.info('preview', `named tunnel registered: ${namedUrl}`);
            tunnel = candidate;
            parsedUrl = namedUrl;
          } else {
            log.info(
              'preview',
              'named tunnel did not register within 45s — falling back to quick tunnel',
            );
            try { candidate.kill('SIGTERM'); } catch { /* already dead */ }
          }
        } catch (e) {
          log.info(
            'preview',
            `named tunnel failed (${(e as Error).message}) — falling back to quick tunnel`,
          );
        }
      }

      for (
        let attempt = 1;
        attempt <= MAX_TUNNEL_ATTEMPTS && !parsedUrl;
        attempt += 1
      ) {
        if (attempt > 1) {
          emitProgress(
            'TUNNEL_STARTING',
            `cloudflared quick tunnel (retry ${attempt}/${MAX_TUNNEL_ATTEMPTS})`,
          );
        }
        const candidate = spawn(
          bin,
          ['tunnel', '--url', `http://localhost:${detection.port}`],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let candidateUrl: string | null = null;
        let registered = false;
        const onTunnelChunk = (chunk: Buffer): void => {
          const s = chunk.toString();
          if (!candidateUrl) candidateUrl = parseCloudflaredUrl(s);
          // cloudflared logs "Registered tunnel connection" once the edge
          // has accepted the connector — the AUTHORITATIVE "tunnel is live"
          // signal. We gate on this instead of resolving the hostname from
          // THIS host: a self-hosted box's resolver (e.g. Docker's embedded
          // 127.0.0.11) can take >40 s to see a fresh trycloudflare record
          // even though the tunnel registered fine and is reachable from the
          // internet — that false-negative failed every self-hosted preview
          // (verified live: 3/3 retries registered, DNS poll timed out).
          if (/Registered tunnel connection/i.test(s)) registered = true;
          // Log cloudflared output under [preview] so tunnel issues are
          // post-hoc debuggable without re-running.
          const trimmed = s.replace(/\n+$/g, '');
          if (trimmed.length > 0) log.info('preview', `cloudflared: ${trimmed}`);
        };
        candidate.stderr!.on('data', onTunnelChunk);
        candidate.stdout!.on('data', onTunnelChunk);
        // Wait for BOTH the URL and the registered-connection line. 45 s
        // covers a cold launch (binary download, QUIC handshake). We do NOT
        // DNS-probe from here — once registered, the edge serves the URL and
        // the mobile WebView rides out its own DNS-propagation window (it no
        // longer caches NXDOMAIN and gives up — see PreviewWebView's retry).
        const deadline = Date.now() + 45_000;
        while ((!candidateUrl || !registered) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 250));
        }
        if (candidateUrl && registered) {
          log.info('preview', `cloudflared tunnel registered: ${candidateUrl}`);
          tunnel = candidate;
          parsedUrl = candidateUrl;
        } else {
          lastTunnelErr = candidateUrl
            ? 'cloudflared did not register a tunnel connection within 45s'
            : 'cloudflared did not emit a URL within 45s';
          try { candidate.kill('SIGTERM'); } catch { /* already dead */ }
        }
      }
      if (!parsedUrl) {
        killProcessTree(devServer, 'SIGTERM');
        void postPreviewEvent({
          sessionId: ctx.sessionId,
          pluginId: ctx.pluginId,
          pluginAuthToken,
          type: 'preview_error',
          payload: {
            stage: 'tunnel',
            message: `Tunnel did not become reachable after ${MAX_TUNNEL_ATTEMPTS} attempts (${lastTunnelErr}). Cloudflare Quick Tunnels occasionally fail to register — please retry.`,
          },
        });
        return;
      }
      url = parsedUrl;
    }

    // 5. Register + announce.
    emitProgress('TUNNEL_READY', url);
    registerPreview(ctx.sessionId, {
      sessionId: ctx.sessionId,
      devServer,
      tunnel,
      url,
      framework: detection.framework,
      detection,
    });
    log.info('preview', `ready: ${detection.framework} at ${url}`);
    void postPreviewEvent({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken,
      type: 'preview_ready',
      payload: { url, framework: detection.framework, port: detection.port },
    });
  })().catch((err) => {
    // Safety net: any UNEXPECTED throw in the detached bring-up (a malformed
    // detection field, a parser bug, etc.) must NOT become a silent unhandled
    // rejection that leaves the mobile preview on a black screen forever.
    // Surface it as a preview_error so the UI can show something actionable.
    const message = err instanceof Error ? err.message : String(err);
    log.warn('preview', `start crashed before ready: ${message}`);
    void postPreviewEvent({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken,
      type: 'preview_error',
      payload: { stage: 'spawn', message: `Preview failed to start: ${message}` },
    });
  });
}

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
  headroom_configure: headroomConfigureH,
  beads_configure: beadsConfigureH,
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
  await handler(ctx, cmd, parsed);
}
