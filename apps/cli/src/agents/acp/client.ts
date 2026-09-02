/**
 * Thin wrapper over `@agentclientprotocol/sdk`'s
 * {@link ClientSideConnection}.
 *
 * Owns the lifecycle of a single adapter process:
 *   spawn → initialize → newSession → forward events → stop.
 *
 * The wrapper has zero protocol logic. It exists to:
 *   - shield the rest of the CLI from the SDK's exact import path
 *     (so we can swap to a hand-rolled JSON-RPC later if needed
 *     without touching every call site),
 *   - bridge Node child-process stdio to the SDK's web-stream
 *     `Stream` interface,
 *   - implement the `Client`-side of the protocol by forwarding
 *     each notification / request to a callback supplied by the
 *     caller.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  RequestError,
  ndJsonStream,
  type Agent,
  type Client,
  type CreateTerminalResponse,
  type InitializeResponse,
  type KillTerminalResponse,
  type McpServer,
  type NewSessionResponse,
  type PromptResponse,
  type ReadTextFileResponse,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionConfigSelectGroup,
  type SessionConfigSelectOption,
  type SessionConfigSelectOptions,
  type SessionModeState,
  type SessionNotification,
  type TerminalOutputResponse,
  type WaitForTerminalExitResponse,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import { tryGetContextWindow, type AgentModel, type AgentMode } from '@codeam/shared';
import type { AdapterSpec } from './adapters';
import { ADAPTER_MODULE_LOAD_ERROR_RE, agentInstallBinDirs } from './agent-binary';
import type { PromptBlock } from './buildAcpPromptBlocks';
import { createIdleTimeout, type IdleTimeout } from './idleTimeout';
import { pathIsInternal, INTERNAL_BLOCK_REASON } from './internal-paths';
import {
  ensureHeadroomProxyReady,
  makeRealProxySupervisorDeps,
} from '../../services/headroom/proxy-supervisor';
import { toolPathIsSecret, GUARDRAIL_SECRET_READ_BLOCK_REASON } from './guardrails';
import { getGuardrailPolicy } from './guardrail-config';
import { modeIsFullAutoApprove } from './modes';
import { isLocalSession } from '../../baton/gate';
import { log } from '../../services/logger';
import { killQuiet } from '../../lib/quiet';

/**
 * Protocol version we advertise during `initialize`. ACP v1 is the
 * stable line; the SDK accepts a numeric major version per its
 * type. Bumping this in the future is a one-liner change.
 */
/** Shape returned by {@link AcpClient.start} / `startOnce`. */
export interface AcpStartResult {
  sessionId: string;
  initialize: InitializeResponse;
  /** Adapter-picked model id, e.g. `gpt-5`. Sourced from the NATIVE ACP model
   *  config option (the `category:'model'` `SessionConfigSelect`'s `currentValue`)
   *  on newSession. `undefined` when the agent exposes no model config option. */
  model?: string;
  /** Plan / service tier label the adapter advertises (`plus`, `pro`, …). */
  tier?: string;
}

/**
 * A transient spawn race the ADAPTER hits INTERNALLY when it execs the real
 * agent binary (e.g. claude-agent-acp spawning the ~250MB SDK-bundled `claude`
 * during newSession). On a fresh/waking codespace that binary is momentarily
 * open-for-write (`ETXTBSY`) or not-yet-renamed (`ENOENT`) — the adapter
 * surfaces it as a `-32603 Internal error` whose stderr/data carries the code.
 * Both clear within milliseconds, so respawning the adapter + re-handshaking
 * recovers. NOT our own spawn (PATH-augmented + gated) — this is one layer down.
 */
const TRANSIENT_ADAPTER_SPAWN_RE = /ETXTBSY|ENOENT/;
const MAX_START_ATTEMPTS = 5;

/**
 * The ACP TRANSPORT went down DURING the handshake. This is the SAME structural
 * fact as {@link AdapterStartCrashError} (the adapter process died before it
 * could complete startup) — just observed from the SDK's side of a race: when
 * the adapter exits mid-`initialize`, its stdout closes and the SDK rejects the
 * in-flight RPC with "ACP connection closed" a beat before (or after) our own
 * child-`exit` handler fires. Since `cleanupAfterFailedStart` synchronously
 * removes the exit listener, that handler sometimes never runs — so we must
 * ALSO recognise the crash by its transport symptom. This is NOT error-code
 * whack-a-mole: it's OUR transport layer's own stable, bounded error, not the
 * install's nondeterministic one. Only consulted during `start()`, where a
 * closed transport can only mean the adapter died starting up (a healthy one
 * stays connected). Auth/tier failures keep the connection OPEN (they RPC-error
 * or hang), so they never match this and are never mis-retried.
 */
const TRANSPORT_DOWN_DURING_START_RE =
  /connection (is )?closed|stream (is )?closed|ECONNRESET|EPIPE|write after end|premature close/i;

/**
 * The adapter rejected a `session/prompt` because ITS side of the ACP session is
 * gone — the agent tore the session down between turns while the adapter process
 * itself stays alive and connected. Kimi (`kimi acp`, ≥0.23) does this: after a
 * turn's `stop_reason:end_turn` (or an idle gap / a self-update that swaps its
 * binary mid-session) it closes the session server-side, so the NEXT prompt on
 * the same sessionId rejects INSTANTLY with `-32603 Internal error` whose
 * `data.details` is `"Session is closed"` (live-verified on codespace
 * 5ggrj7xgpgxwcv75v, kimi 0.23.6). claude/codex/gemini/cursor keep the session
 * alive across turns and NEVER emit this, so matching it is agent-safe: the
 * recovery only ever engages for an adapter that actually closed the session.
 * The text is highly specific (the error code alone — a generic `-32603` — is
 * NOT enough; the adapter's own transient spawn races reuse that code), so we
 * key on the `session is closed` phrase carried in `message`/`details`/`data`.
 */
const SESSION_CLOSED_RE = /session is closed/i;

/**
 * The adapter process EXITED during the initial handshake (before `initialize`
 * resolved). This is the STRUCTURAL signal of a fresh-install startup race: a
 * healthy adapter loads its whole module graph then blocks reading the ACP
 * handshake off stdin — it never exits mid-startup. So a crash here means a
 * still-installing dependency broke the adapter's `import`, WHATEVER Node error
 * code that particular file/package yields at that instant. Classifying on this
 * fact (not on an enumerated error-string list) is what stops the whack-a-mole:
 * `SyntaxError`→`ERR_MODULE_NOT_FOUND`→`ERR_UNSUPPORTED_DIR_IMPORT`→… all land
 * here and are retried uniformly. A genuinely permanent crash-at-import just
 * fails all {@link MAX_START_ATTEMPTS} attempts and surfaces the real error.
 * (Permanent auth/tier failures do NOT crash the process — they hang or RPC-
 * error and are caught by {@link FATAL_STARTUP_RE}, so they never reach here.)
 */
export class AdapterStartCrashError extends Error {
  readonly adapterExitedDuringStart = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'AdapterStartCrashError';
  }
}

/** Backoff seam so the transient-spawn retry is instant under test. */
export const _acpStartSeam = {
  sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
};

const PROTOCOL_VERSION = 1;

/**
 * Adapter stderr patterns that mean "the agent will NEVER produce a usable
 * session" — auth failures and tier-ineligibility. `gemini --acp` logs these
 * to stderr but does NOT reject `newSession`, so it would otherwise hang
 * forever (the "STILL LOADING SESSION HISTORY / offline" report). Matching one
 * lets us fail `newSession` immediately with the real cause.
 *
 * `IneligibleTierError` is Google's post-2026-06-18 deprecation of the free /
 * consumer Gemini Code Assist tier for the CLI (UNSUPPORTED_CLIENT) — only paid
 * Code Assist Standard/Enterprise still works.
 */
export const FATAL_STARTUP_RE =
  /IneligibleTierError|UNSUPPORTED_CLIENT|no longer supported for Gemini Code Assist|not eligible for Gemini Code Assist|Error authenticating|ProjectIdRequiredError/i;

/**
 * Backstop ceiling for `newSession`. Legitimate first-run onboarding (a paid
 * Code Assist account provisioning a project) can take tens of seconds, so this
 * is generous — the FATAL_STARTUP_RE fast-path handles the common failures
 * immediately; this only catches a silent hang with no diagnostic stderr.
 */
const NEWSESSION_TIMEOUT_MS = 120_000;

/**
 * Backstop ceiling for `session/load`. It was the ONE handshake RPC with no
 * timeout, and a wedged adapter simply never answered: the 2026-08-18 baton
 * incident logged `loadSession → sessionId=…` with no `← ok` and no error, ever
 * — the take-control hand-off then sat in `SWITCHING` for the rest of the
 * session (`claude-agent-acp` never resolves `session/load` for an id that has
 * no transcript on disk). A load replays an existing conversation the agent
 * already has locally, so it is far cheaper than first-run onboarding — 60 s is
 * already an order of magnitude past a healthy load.
 */
const LOADSESSION_TIMEOUT_MS = 60_000;

/**
 * IDLE window for a single `session/prompt` round-trip — the max time
 * the adapter may go silent (no `session/update`, no in-flight
 * permission request) before we treat it as wedged and fail the turn.
 *
 * This is deliberately an inactivity timeout, NOT a total-elapsed cap.
 * A real agentic turn runs for minutes — reasoning, many tool calls,
 * and human-in-the-loop approvals — while emitting an update every few
 * seconds. A total-elapsed ceiling killed those healthy turns the
 * instant their wall-clock crossed it (the mobile client then never
 * saw the final answer; reported as "the agent stopped responding
 * after I approved a few prompts"). 90 s of pure silence is well past
 * any legitimate gap between updates, so a genuinely stuck adapter
 * still surfaces as a normal "failed" command result, not a permanent
 * "Thinking…" spinner — while long-but-active work runs to completion.
 */
const PROMPT_IDLE_TIMEOUT_MS = 90_000;
/**
 * Relaxed idle window once the turn has streamed ≥1 update (proof the
 * adapter is alive). Covers legitimately silent long phases — above all
 * context auto-compaction, a single multi-minute summarization call that
 * emits nothing until it finishes. See idleTimeout.ts for the incident.
 */
const PROMPT_ACTIVE_IDLE_TIMEOUT_MS = 600_000;

/**
 * Capabilities we advertise to the agent. Phase 1 supports:
 *   - fs.readTextFile / writeTextFile — implemented below against
 *     local node:fs, so the agent can read / write files in the
 *     user's working tree.
 *   - terminal.* — declared as `false` so the agent doesn't try to
 *     spawn terminals through us (Phase 2). The adapters that we
 *     ship for Claude / Codex / Cursor all gracefully fall back
 *     when this capability is missing.
 */
const CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: false,
};

export interface AcpClientOptions {
  /** Spec resolved from {@link getAcpAdapter}. */
  adapter: AdapterSpec;
  /**
   * Extra environment variables merged into the adapter spawn (on top of
   * `process.env`, before the augmented `PATH`). Lets the runner inject
   * `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` on an on-demand re-spawn — claude
   * reads that knob only at process start, so it must be in the spawn env,
   * not set after the fact. Empty/omitted by default. An `undefined` value
   * DELETES the variable from the child env (Node's `spawn` omits
   * `undefined`-valued entries) — how a switch away from the house agent
   * strips the managed-proxy routing the process env still carries.
   */
  extraEnv?: Record<string, string | undefined>;
  /** Working directory for the agent's session (becomes the
   *  primary `cwd` ACP root). */
  cwd: string;
  /** Agent Toolkits integration MCP servers to advertise on `newSession` /
   *  `loadSession` (built by {@link buildMcpServersForStart}). Omitted/empty
   *  when the caller has no manifest or the agent doesn't need any. */
  mcpServers?: McpServer[];
  /** Forwarded for every `session/update` notification the agent
   *  sends. Mapping to chunks happens in the caller via the
   *  pure mappers — this wrapper is just a relay. */
  onSessionUpdate: (notification: SessionNotification) => void;
  /** Called when the agent asks the user to allow / reject a tool
   *  call. The caller publishes an awaiting-answer to mobile and
   *  resolves once the user replies. Throwing or returning
   *  `outcome.kind === 'cancelled'` aborts the tool. */
  onRequestPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  /** Called on adapter stderr lines for debugging — log surface
   *  the caller owns so we don't have to pick stdout vs stderr
   *  semantics here. */
  onStderr?: (line: string) => void;
  /** Called when the adapter process exits unexpectedly so the
   *  caller can tear down the session. Not called on a normal
   *  `stop()` shutdown. */
  onUnexpectedExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /**
   * Bracketed around the recovery `session/load` in
   * {@link AcpClient.reestablishSession}. kimi's `session/load` REPLAYS the
   * whole prior conversation as `session/update` notifications before it
   * resolves; those flow through {@link onSessionUpdate} and, if published as
   * live chunks, prepend a PRIOR turn's text to the recovered turn's reply (the
   * "¡Hola!…" glued in front of the real answer P0). The runner wires these to
   * `StreamingState.beginLoadReplay/endLoadReplay` so the replay is swallowed
   * for the load window only. Optional: the happy path never calls loadSession,
   * so if unset the bracket is a no-op. Mirrors the baton's load-replay guard. */
  beginLoadReplay?: () => void;
  endLoadReplay?: () => void;
  /**
   * Override the MCP reprovision debounce window (ms). Test seam only —
   * production leaves it unset and gets {@link MCP_REPROVISION_DEBOUNCE_MS}.
   * Faking timers instead would freeze the adapter handshake too.
   */
  mcpReprovisionDebounceMs?: number;
}

/**
 * How long to wait after the LAST integration change before respawning.
 *
 * A respawn is expensive and its cost is visible: measured on a real box, 29 s
 * to bind 14 MCP servers — ~13 s for `session/new` (each integration is a node
 * process with its own MCP handshake, ~0.9 s each) plus ~13 s for
 * `session/load` to replay the conversation. There is no cheaper path: MCP
 * servers bind at `session/new`, so a live session cannot gain one without a
 * full respawn.
 *
 * Without this window, EVERY change pays that price. A user adding connectors
 * one at a time — the natural way to do it — triggered one respawn each, so ten
 * integrations meant ten respawns back to back (rafaelph90.br@gmail.com,
 * 2026-09-02). Ten seconds is longer than the gap between two deliberate taps
 * and far shorter than the respawn itself, so a burst of changes collapses into
 * the single respawn it should always have been.
 */
export const MCP_REPROVISION_DEBOUNCE_MS = 10_000;

export class AcpClient {
  private child: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private stopping = false;
  private sessionId: string | null = null;
  /** The id of the NATIVE ACP `category:'model'` `SessionConfigSelect` option
   *  captured from `newSession`/`loadSession` `configOptions`. It's the SINGLE
   *  source of truth for model listing/switching: `session/set_config_option`
   *  targets this id, and `undefined` here means the agent exposes no native
   *  model selector → {@link getAvailableModels} is empty and {@link setModel}
   *  throws (mobile then hides the picker). */
  private modelConfigId: string | undefined = undefined;
  /** The models the native model config option advertises — mapped from its
   *  `options` (id = option `value`, label = option `name`). Empty when the
   *  agent has no model config option. NO hardcoded fallback. */
  private availableModels: AgentModel[] = [];
  /** The native model select's current value — seeded from the config option's
   *  `currentValue` and updated on a successful {@link setModel}. Exposed via
   *  {@link getCurrentModelId} so `list_models` can report the in-use model to
   *  mobile (the model line under the composer). `undefined` when no model
   *  config option is advertised. */
  private currentModelId: string | undefined = undefined;
  /** The operating/permission MODES the native ACP `SessionModeState` advertises
   *  (a DIFFERENT axis than models) — mapped from `newSession`/`loadSession`
   *  `modes.availableModes` (id = mode id, label = mode name, description passthrough).
   *  Empty when the agent advertises no modes → {@link getAvailableModes} is empty
   *  and {@link setMode} throws (mobile then hides the mode picker). */
  private availableModes: AgentMode[] = [];
  /** The native `SessionModeState.currentModeId` — seeded from `modes.currentModeId`
   *  and updated on a successful {@link setMode}. Exposed via {@link getCurrentModeId}
   *  so `list_modes` can report the in-use mode to mobile. `undefined` when the agent
   *  advertises no modes. */
  private currentModeId: string | undefined = undefined;
  /** Whether the agent advertised `loadSession` on `initialize`. Drives the
   *  post-turn session-closed recovery: an agent that supports resume (kimi,
   *  claude, codex, gemini) is re-established with `session/load` — preserving
   *  the conversation — whereas one without it falls back to a fresh
   *  `session/new`. Set once during {@link startOnce}. */
  private supportsLoadSession = false;
  private supportsListSessions = false;
  /** Idle watchdog for the in-flight prompt. The `Client` handlers
   *  (`sessionUpdate` / `requestPermission`) reach for this to keep
   *  the turn alive while the adapter is demonstrably working. Null
   *  between prompts. */
  private promptIdle: IdleTimeout | null = null;
  /** Tool calls the adapter has started but not yet reported terminal
   *  (`completed`/`failed`). A long-running tool — typecheck, build,
   *  install, a big test run — emits NO `session/update` for its whole
   *  duration, which can exceed the idle window and falsely trip the
   *  watchdog. While ANY tool is outstanding we SUSPEND the watchdog
   *  (the agent is demonstrably working, just blocked on the tool), and
   *  re-arm only once the last one finishes. Reset per prompt. */
  private pendingToolCalls = new Set<string>();
  /** Serializes {@link prompt}: each turn waits for the previous to fully
   *  settle before arming its own watchdog. `promptIdle`/`pendingToolCalls`
   *  are single-instance fields, so a 2nd concurrent prompt() would overwrite
   *  them mid-turn and break turn A's idle watchdog (mobile "send-while-active"
   *  can fire two prompts back-to-back). See {@link prompt}. */
  private promptChain: Promise<unknown> = Promise.resolve();
  /**
   * Coalescing state for {@link reprovisionMcp}. A burst of integration events
   * (the user linking several connectors in a row) used to fire one respawn per
   * event, each killing the adapter the previous had just started — see the
   * comment on that method.
   */
  /** True once a start has fully succeeded (handshake + session). Distinguishes
   *  "never started" (a programming error) from "the adapter died" (recoverable). */
  private startedOnce = false;
  private mcpReprovisionPending: McpServer[] | null = null;
  private mcpDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private mcpDebounceWaiters: Array<(v: 'reloaded' | 'deferred') => void> = [];
  /** Last few adapter stderr lines — so a startup failure surfaces the REAL
   *  cause (e.g. gemini's `IneligibleTierError`) instead of a bare timeout. */
  private recentStderr: string[] = [];
  /** Set while `newSession` is in flight; the stderr watcher calls it to fail
   *  fast when the adapter prints a fatal startup error. `gemini --acp`
   *  swallows the Code Assist onboarding error and never rejects `newSession`,
   *  so without this the session hangs forever ("loading… / offline"). */
  private startupFailureReject: ((err: Error) => void) | null = null;
  /** Set for the WHOLE initial handshake (initialize → newSession). The child
   *  `exit` handler calls it when the adapter dies mid-startup — e.g. it crashes
   *  at `import` (ERR_MODULE_NOT_FOUND on a still-installing dep) BEFORE the
   *  `initialize` response the handshake awaits would ever arrive. Without it,
   *  `startOnce` hangs on that response and `start()`'s transient-retry never
   *  engages; with it, the crash rejects immediately → retry respawns once the
   *  install settles. Broader than {@link startupFailureReject} (newSession-only). */
  private startAbortReject: ((err: Error) => void) | null = null;

  constructor(private readonly opts: AcpClientOptions) {}

  /**
   * Spawn the adapter + handshake, retrying a TRANSIENT in-adapter spawn race.
   *
   * The adapter itself execs the real agent binary (claude-agent-acp spawns the
   * ~250MB SDK-bundled `claude` during newSession). On a fresh/waking codespace
   * that binary is momentarily open-for-write → the adapter rejects newSession
   * with `-32603 … spawn ETXTBSY` (or ENOENT before it lands). Both clear within
   * ms, so we respawn the adapter + re-handshake up to {@link MAX_START_ATTEMPTS}
   * times. `startOnce` fully cleans up on failure (see cleanupAfterFailedStart),
   * so each retry starts from a clean slate. Non-transient failures throw on the
   * first attempt — no masking of real auth/outage errors.
   */
  async start(): Promise<AcpStartResult> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt += 1) {
      try {
        return await this.startOnce();
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_START_ATTEMPTS && this.isTransientAdapterSpawn(err)) {
          log.info(
            'acpClient',
            `adapter hit a transient spawn race (binary busy) — retrying start ${attempt + 1}/${MAX_START_ATTEMPTS}`,
          );
          await _acpStartSeam.sleep(400 * attempt);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  /** True when a failed {@link startOnce} was caused by a TRANSIENT install
   *  race that clears within ms, so respawning the adapter recovers. Two
   *  distinct races, both fresh-codespace only:
   *   1. The adapter's OWN spawn of the agent binary (`claude-agent-acp`
   *      exec'ing the ~250 MB SDK-bundled `claude`) mid-atomic-rename →
   *      `ETXTBSY`/`ENOENT`.
   *   2. The adapter's OWN `import` of a still-installing dependency
   *      (`claude-agent-acp` importing `@anthropic-ai/claude-agent-sdk/sdk.mjs`
   *      before npm finished the package's atomic rename) → the node process
   *      exits at load with `ERR_MODULE_NOT_FOUND` / a truncated-file
   *      `SyntaxError` (2026-07-10 incident: EVERY codespace claude deploy died
   *      "The claude agent failed to start" here — the pre-spawn module-graph
   *      gate probes just BEFORE the real spawn, leaving a TOCTOU window npm's
   *      rename slips through). {@link ADAPTER_MODULE_LOAD_ERROR_RE} matches it.
   *  Checks the thrown error's message/data AND the adapter stderr ring — the
   *  adapter logs the real cause to stderr while returning a generic error. */
  private isTransientAdapterSpawn(err: unknown): boolean {
    // PRIMARY (structural): the adapter process died during the handshake — a
    // healthy one never exits there, so this IS an install-race crash whatever
    // the error code. This is what stops the error-code whack-a-mole; the regex
    // below is only a secondary text-based fallback.
    if (err instanceof AdapterStartCrashError) return true;

    const parts: string[] = [...this.recentStderr];
    if (err instanceof Error) parts.push(err.message);
    if (err && typeof err === 'object') {
      const e = err as { data?: unknown; details?: unknown };
      try {
        parts.push(JSON.stringify(e.data));
      } catch {
        /* circular / non-serialisable data — ignore */
      }
      if (typeof e.details === 'string') parts.push(e.details);
    }
    const joined = parts.join(' ');
    return (
      TRANSIENT_ADAPTER_SPAWN_RE.test(joined) ||
      ADAPTER_MODULE_LOAD_ERROR_RE.test(joined) ||
      // The transport dying mid-handshake = the adapter crashed starting up,
      // even when the child-exit handler lost the race (see the RE's doc).
      TRANSPORT_DOWN_DURING_START_RE.test(joined)
    );
  }

  private async startOnce(): Promise<AcpStartResult> {
    if (this.child) throw new Error('AcpClient already started');
    // Fresh adapter → drop any stderr from a prior (retried) attempt so
    // `isTransientAdapterSpawn` only sees THIS attempt's output.
    this.recentStderr.length = 0;

    const { adapter, cwd } = this.opts;
    // Expand PATH to cover every well-known npm-global / nvm bin dir
    // on a developer's machine so a global install in ANY node tree
    // is findable. Real failure mode that triggered this code:
    // GitHub Codespaces installs gemini under
    // `/usr/local/share/nvm/versions/node/v24.14.0/bin/` (the
    // codespace image's default node) but codeam runs under our own
    // `/tmp/codeam-node20/bin/node`. Without this augmentation,
    // `spawn('gemini', ['--acp'])` fails ENOENT and the user sees
    // "thinking…" forever after a dormant-wake. PATH expansion is
    // additive — we only PREPEND known dirs, never replace, so a
    // user with a custom shell PATH keeps their resolution order.
    const augmentedPath = expandPathForAgentBinaries(process.env.PATH ?? '');
    log.info(
      'acpClient',
      `spawn cmd=${adapter.command} args=[${adapter.args.join(',')}] cwd=${cwd}`,
    );
    const child = spawn(adapter.command, adapter.args, {
      cwd,
      // extraEnv (e.g. CLAUDE_CODE_DISABLE_1M_CONTEXT=1 on an on-demand
      // re-spawn) layers over process.env; PATH stays last so the augmented
      // PATH always wins.
      env: { ...process.env, ...(this.opts.extraEnv ?? {}), PATH: augmentedPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) {
          // Bump to info — adapter stderr is the primary signal when
          // the agent's auth / install / config is wrong and the
          // protocol just stalls. Trace-level suppression hid the
          // root cause on every smoke test up to v2.27.6.
          log.info('acpAdapter', trimmed);
          this.opts.onStderr?.(trimmed);
          this.recentStderr.push(trimmed);
          if (this.recentStderr.length > 12) this.recentStderr.shift();
          // Fail `newSession` fast when the adapter prints a fatal startup
          // error (auth / tier ineligibility). gemini --acp logs these to
          // stderr but never rejects the RPC, so the only other signal is the
          // timeout backstop — surfacing it here makes the error immediate.
          if (this.startupFailureReject && FATAL_STARTUP_RE.test(trimmed)) {
            this.startupFailureReject(new Error(`AGENT_STARTUP_FAILED: ${trimmed}`));
            this.startupFailureReject = null;
          }
        }
      }
    });

    child.on('exit', (code, signal) => {
      if (this.stopping) return;
      log.warn('acpClient', `adapter exited unexpectedly code=${code} signal=${signal}`);
      // If the adapter dies DURING the initial handshake (before start()
      // resolves), reject the in-flight startup so start() can classify + retry
      // — otherwise the pending `initialize` awaits a response that will never
      // come and hangs. A fresh-codespace import crash (ERR_MODULE_NOT_FOUND on
      // a still-installing dep) lands here; its cause is already in recentStderr,
      // which `isTransientAdapterSpawn` inspects. Suppress `onUnexpectedExit` in
      // this case — start()'s retry loop owns the outcome (recover or rethrow).
      if (this.startAbortReject) {
        const tail = this.recentStderr.slice(-6).join(' | ');
        this.startAbortReject(
          new AdapterStartCrashError(
            `ADAPTER_EXITED_DURING_START code=${code} signal=${signal}${tail ? ` — ${tail}` : ''}`,
          ),
        );
        this.startAbortReject = null;
        return;
      }
      this.opts.onUnexpectedExit?.(code, signal);
    });

    // spawn(2) failures arrive as an ASYNC 'error' event. With no
    // listener, Node rethrows them as an uncaught exception and the
    // WHOLE relay process dies — that's the `spawn ENOEXEC` crash a
    // user hit. (PATH expansion above only prevents ENOENT for a
    // missing binary; ENOEXEC — wrong-architecture binary or a script
    // without a shebang / +x — slips past it.) Catch it, surface a
    // useful message to mobile, and route it through the same
    // unexpected-exit path so the relay stays connected.
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (this.stopping) return;
      const code = err.code ?? err.message;
      const hint =
        err.code === 'ENOEXEC'
          ? ' — the agent binary looks like the wrong architecture or a non-executable script'
          : err.code === 'ENOENT'
            ? ` — '${adapter.command}' was not found on PATH`
            : err.code === 'EACCES'
              ? ` — '${adapter.command}' is not executable`
              : '';
      log.error('acpClient', `adapter spawn failed: ${code}${hint}`);
      this.opts.onStderr?.(`Failed to launch ${adapter.command}: ${code}${hint}`);
      this.opts.onUnexpectedExit?.(null, null);
    });

    // Everything from here through the `return` is the post-spawn
    // handshake. If ANY of it throws (missing stdio handles, initialize
    // rejecting, newSession rejecting/timing out), the child is already
    // assigned to `this.child` — without the catch below it would stay
    // set forever and every subsequent `start()` would hard-throw
    // 'AcpClient already started', permanently wedging a caller (e.g. the
    // baton's AcpDriver on a failed take-control) that expects a fresh
    // `start()` to be retryable. On failure we kill the half-started
    // child and reset all state `start()` set, then rethrow the original
    // error unchanged so callers keep seeing the real failure reason.
    try {
      if (!child.stdin || !child.stdout) {
        throw new Error('Spawned ACP adapter is missing stdio handles');
      }

      // Bridge Node streams ↔ the SDK's web-stream Stream surface.
      // The SDK ships `ndJsonStream(output, input)` which adapts
      // newline-delimited JSON over byte streams; we hand it the
      // child's stdout (input) + stdin (output) wrapped as web
      // streams via Node's `Readable.toWeb`/`Writable.toWeb`.
      const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
      const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
      const stream = ndJsonStream(output, input);

      this.connection = new ClientSideConnection((_agent: Agent) => this.buildClient(), stream);

      // Reject the WHOLE handshake if the child dies mid-startup (see
      // startAbortReject / the exit handler). A never-rejected startAborted just
      // stays pending; startAbortReject is cleared on success (before return)
      // and in cleanupAfterFailedStart.
      const startAborted = new Promise<never>((_, reject) => {
        this.startAbortReject = reject;
      });

      log.info('acpClient', 'initialize → sending');
      const initialize = await Promise.race([
        this.connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: CLIENT_CAPABILITIES,
        }),
        startAborted,
      ]);
      log.info(
        'acpClient',
        `initialize ← ok protocolVersion=${initialize.protocolVersion} agentCaps=${JSON.stringify(initialize.agentCapabilities ?? {}).slice(0, 200)}`,
      );
      // Remember whether the agent can resume a session — the closed-session
      // recovery (see runPrompt) prefers `session/load` over a context-losing
      // `session/new` when the agent supports it.
      this.supportsLoadSession =
        (initialize.agentCapabilities as { loadSession?: boolean } | undefined)?.loadSession ===
        true;
      // Agent-agnostic conversation enumeration: any ACP agent that advertises
      // sessionCapabilities.list answers session/list with the full SessionInfo
      // set (id + agent-authored title + updatedAt) — so the RECENT list works
      // for claude/codex/gemini alike without per-agent JSONL scanning.
      this.supportsListSessions = !!(
        initialize.agentCapabilities as { sessionCapabilities?: { list?: unknown } } | undefined
      )?.sessionCapabilities?.list;

      log.info('acpClient', 'newSession → sending');
      // Race the RPC against (a) a fatal stderr line (auth / tier ineligibility),
      // surfaced fast by the stderr watcher, and (b) a generous timeout backstop.
      // Without this, `gemini --acp` hangs forever when Code Assist onboarding is
      // rejected (it swallows the error instead of failing the RPC).
      let startupTimer: ReturnType<typeof setTimeout> | undefined;
      const startupFailure = new Promise<never>((_, reject) => {
        this.startupFailureReject = reject;
        startupTimer = setTimeout(() => {
          const tail = this.recentStderr.slice(-4).join(' | ');
          reject(
            new Error(
              `AGENT_STARTUP_TIMEOUT: ${this.opts.adapter.requiresAgentBinary} did not create a session within ${Math.round(
                NEWSESSION_TIMEOUT_MS / 1000,
              )}s${tail ? ` — last output: ${tail}` : ''}`,
            ),
          );
        }, NEWSESSION_TIMEOUT_MS);
      });
      let newSession: Awaited<ReturnType<ClientSideConnection['newSession']>>;
      try {
        newSession = await Promise.race([
          this.connection.newSession({ cwd, mcpServers: this.opts.mcpServers ?? [] }),
          startupFailure,
          startAborted,
        ]);
      } finally {
        if (startupTimer) clearTimeout(startupTimer);
        this.startupFailureReject = null;
      }
      // Handshake fully succeeded — a later child exit is a genuine
      // unexpected-exit, not a startup abort.
      this.startAbortReject = null;
      this.sessionId = newSession.sessionId;
      // From here on, a missing connection means the adapter DIED rather than
      // "was never started" — which is what lets `runPrompt` restart it instead
      // of failing every turn forever. See the note there.
      this.startedOnce = true;
      // Capture the NATIVE model config option (category:'model' select) — the
      // single source of truth for `list_models` / `change_model`. Sets
      // modelConfigId + availableModels + currentModelId (all empty/undefined
      // when the agent exposes no model selector — NO hardcoded fallback).
      this.captureModelConfig(newSession.configOptions ?? []);
      // Capture the NATIVE ACP session MODES (`SessionModeState`) — a DIFFERENT
      // axis than models. Sets availableModes + currentModeId (empty/undefined
      // when the agent advertises no modes — NO hardcoded fallback).
      this.captureModes(newSession.modes ?? null);
      // `currentServiceTier` is a legacy non-standard codex-acp field surfaced
      // only in the welcome banner — not part of the native model contract.
      // ⚠️ VALIDATE, don't trust the cast. Adapters have been observed sending
      // `[]` here; `[]` is TRUTHY and `String([])` is `''`, which rendered the
      // welcome card as "Cursor Agent · default · " (and, with an array model,
      // "Cursor Agent · default[]"). Anything that isn't a non-empty string is
      // treated as absent.
      const tier = nonEmptyString(
        (newSession as unknown as { currentServiceTier?: unknown }).currentServiceTier,
      );
      // Log the model so account-mismatch bugs (e.g. an adapter defaulting to a
      // model the user's account doesn't include) are immediately visible in
      // the smoke-test log instead of surfacing as a cryptic "Authentication
      // required" / "model not supported" error from the prompt response.
      log.info(
        'acpClient',
        `newSession ← ok sessionId=${newSession.sessionId.slice(0, 8)}` +
          ` model=${this.currentModelId ?? '?'}` +
          ` models=${this.availableModels.length}` +
          ` tier=${tier ?? '?'}`,
      );

      return {
        sessionId: newSession.sessionId,
        initialize,
        model: this.currentModelId,
        tier,
      };
    } catch (err) {
      this.cleanupAfterFailedStart(child);
      throw err;
    }
  }

  /**
   * Undo the partial state `start()` set before its handshake threw, so a
   * fresh `start()` call is retryable instead of permanently hard-throwing
   * 'AcpClient already started'. Removes OUR `exit`/`error` listeners first
   * so killing the half-started child doesn't also fire
   * `onUnexpectedExit` — the baton's `onUnexpectedExit` calls
   * `process.exit`, which must never fire for a failure the caller already
   * received as a thrown error from `start()`.
   */
  private cleanupAfterFailedStart(child: ChildProcess): void {
    child.removeAllListeners('exit');
    child.removeAllListeners('error');
    killQuiet(child, 'SIGKILL');
    this.child = null;
    this.connection = null;
    this.sessionId = null;
    this.startupFailureReject = null;
    this.startAbortReject = null;
  }

  /**
   * Send a user prompt to the active session. Returns the
   * {@link PromptResponse} which carries the agent's stop reason
   * once the turn finishes. Session/update notifications keep
   * arriving on `onSessionUpdate` while the turn streams.
   *
   * Wrapped in a hard timeout because adapters CAN hang silently
   * when their underlying agent's auth/network is broken — without
   * a ceiling the relay command sits "pending" forever and mobile
   * shows a permanent "Thinking…" spinner with no way to recover.
   */
  async prompt(input: string | ReadonlyArray<PromptBlock>): Promise<PromptResponse> {
    // Serialize turns (9u9): `promptIdle`/`pendingToolCalls` are single-instance
    // fields, so a 2nd prompt() arriving while one is in flight would overwrite
    // this.promptIdle + clear this.pendingToolCalls mid-turn — turn A's idle
    // watchdog then stops being fed and can spuriously fail 'ACP prompt idle'
    // while the agent is still working. Mobile "send-while-active" makes this
    // reachable. Chain each prompt after the previous fully settles; the adapter
    // FIFO-queues too, but the CLI-side watchdog state must not be clobbered
    // before it does. A failed/rejected prompt never wedges the chain.
    const run = this.promptChain.then(() => this.runPrompt(input));
    this.promptChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runPrompt(input: string | ReadonlyArray<PromptBlock>): Promise<PromptResponse> {
    // ⚠️ RECOVER a dead adapter rather than failing forever. This used to throw
    // immediately, which turned any one-off adapter death into a permanently
    // broken session: every subsequent turn answered "The agent hit an error and
    // couldn't finish this turn" and nothing ever re-started the adapter, so the
    // user retried into the same wall (live incident 2026-09-02 — three "Hola"s,
    // three identical errors, session unusable until restarted).
    //
    // `startedOnce` is the discriminator: before the first successful start,
    // "called before start()" is a genuine programming error and must still
    // throw. After it, a missing connection means the adapter DIED, and the
    // session is recoverable — that is exactly what `startOnce()` does.
    if (!this.connection || !this.sessionId) {
      if (!this.startedOnce) {
        throw new Error('AcpClient.prompt called before start()');
      }
      log.warn('acpClient', 'adapter is gone — restarting it before this turn');
      this.stopping = false;
      await this.startOnce();
      if (!this.connection || !this.sessionId) {
        throw new Error('AcpClient.prompt: adapter could not be restarted');
      }
      log.info('acpClient', 'adapter restarted — resuming the turn');
    }
    // Self-heal the shared Headroom proxy BEFORE every turn (best-effort). On a
    // codespace resume / host-agent restart the detached :8787 proxy can be
    // SIGTERM'd and never relaunched, leaving ANTHROPIC_BASE_URL pointing at a
    // dead port → every turn fails "API Error: ConnectionRefused" until the 30 s
    // heartbeat supervisor happens to respawn it (Rafael, 2026-08-08 — the proxy
    // stayed dead ~9 min). A cheap `/livez` probe (no-op when alive OR Headroom
    // isn't configured — the common case) respawns + waits when it's down, so the
    // user's turn recovers on the spot instead of erroring. Never throws.
    await ensureHeadroomProxyReady(makeRealProxySupervisorDeps()).catch(() => undefined);
    // Normalise: plain string callers (slash commands, free-form
    // replies) shouldn't have to build a single-block array; the
    // start_task path with image attachments passes the array directly
    // so it can interleave `image` + `text` blocks.
    const blocks: PromptBlock[] =
      typeof input === 'string' ? [{ type: 'text', text: input }] : (input as PromptBlock[]);
    try {
      return await this.sendPromptOnce(blocks);
    } catch (err) {
      // Post-turn session-closed recovery (kimi). The agent closed its ACP
      // session between turns, so this prompt rejected INSTANTLY with
      // `-32603 … "Session is closed"`. Transparently re-establish the session
      // and retry the prompt ONCE so multi-turn keeps working — the user sees a
      // normal streamed reply, not the turn-failure bubble. Gated on the
      // specific closed-session error (SESSION_CLOSED_RE): agents that keep the
      // session alive across turns (claude/codex/gemini/cursor) never emit it,
      // so their happy path is byte-for-byte unchanged and pays ZERO latency
      // here. A second closed-session error on the retry propagates (no loop).
      if (this.isSessionClosedError(err)) {
        log.warn(
          'acpClient',
          "session/prompt rejected 'Session is closed' — re-establishing session and retrying once",
        );
        await this.reestablishSession();
        return await this.sendPromptOnce(blocks);
      }
      throw err;
    }
  }

  /**
   * Send ONE `session/prompt` round-trip with the idle watchdog. Extracted from
   * {@link runPrompt} so the closed-session recovery can re-invoke it for the
   * single retry without duplicating the watchdog / tool-ledger setup.
   */
  private async sendPromptOnce(blocks: PromptBlock[]): Promise<PromptResponse> {
    if (!this.connection || !this.sessionId) {
      throw new Error('AcpClient.sendPromptOnce called before start()');
    }
    const textLen = blocks.reduce((n, b) => (b.type === 'text' ? n + b.text.length : n), 0);
    const imageCount = blocks.reduce((n, b) => (b.type === 'image' ? n + 1 : n), 0);
    log.info(
      'acpClient',
      `prompt → session=${this.sessionId.slice(0, 8)} textChars=${textLen} imageBlocks=${imageCount}`,
    );
    const t0 = Date.now();
    const send = this.connection.prompt({
      sessionId: this.sessionId,
      prompt: blocks,
    });

    // Idle watchdog, NOT a total-elapsed cap. The `Client` handlers
    // bump it on every `session/update` and suspend it across a
    // human permission wait (see `buildClient`), so a long-but-active
    // turn never trips it — only a genuinely silent adapter does. See
    // PROMPT_IDLE_TIMEOUT_MS for the full rationale.
    const idle = createIdleTimeout(
      PROMPT_IDLE_TIMEOUT_MS,
      () =>
        new Error(
          `ACP prompt idle — adapter sent no updates for the idle window ` +
            `(${PROMPT_IDLE_TIMEOUT_MS / 1000}s silent-from-start / ` +
            `${PROMPT_ACTIVE_IDLE_TIMEOUT_MS / 1000}s once active). ` +
            `Likely the underlying agent's auth or network is misconfigured; check the adapter stderr ` +
            `lines above (acpAdapter tag) for the actual error.`,
        ),
      PROMPT_ACTIVE_IDLE_TIMEOUT_MS,
    );
    this.promptIdle = idle;
    // Fresh tool-call ledger per turn so a stale entry from a prior
    // turn can't keep this turn's watchdog suspended forever.
    this.pendingToolCalls.clear();
    try {
      const result = await Promise.race([send, idle.promise]);
      // Root-cause fix (fleet-1 handoff-robustness round 3, empirically
      // confirmed on a live box): the ACP SDK's stdio dispatch resolves a
      // `session/prompt` RPC response in ONE promise hop
      // (`Peer.handleResponse` → `pendingResponse.resolve`), but dispatches a
      // TRAILING `session/update` notification (e.g. the reply's very last
      // text delta) via a fire-and-forget chain several `await` hops deep
      // (`Peer.receiveMessage` → `void processIncomingMessage(...)` →
      // per-handler `handleMessage` iteration). When the adapter sends both
      // back-to-back, the single-hop response can resolve BEFORE the
      // multi-hop notification chain finishes — even though the notification
      // was read off the wire FIRST. `streaming.append()` for that last
      // delta then hasn't run yet when the caller reads
      // `getCurrentText()` right after this `await` unblocks, silently
      // truncating the reply (verified live: a reply ending
      // "…}\n```" landed as "…}\n" — the closing fence never made it into
      // the accumulated text). `setImmediate` is a hard barrier: Node fully
      // drains the microtask queue — however many hops deep — before running
      // ANY macrotask, so this reliably waits out an ALREADY-STARTED
      // notification chain without guessing at a duration. One-shot, not a
      // polling loop.
      await new Promise<void>((resolve) => setImmediate(resolve));
      log.info(
        'acpClient',
        `prompt ← ok stopReason=${result.stopReason ?? '?'} elapsedMs=${Date.now() - t0}`,
      );
      return result;
    } catch (err) {
      // If the watchdog won the race, `send` is still in flight;
      // swallow its eventual settlement so a late adapter rejection
      // can't surface as an unhandled rejection and crash the runner
      // (the v2.27.9 codex smoke test caught exactly this class).
      void send.catch(() => {});
      log.warn(
        'acpClient',
        `prompt ← failed elapsedMs=${Date.now() - t0} err=${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    } finally {
      // Permanently disarm so a late bump/timer can't reject after
      // we've moved on, and drop the handle for the next prompt.
      idle.clear();
      this.promptIdle = null;
    }
  }

  /**
   * True when a `session/prompt` rejection is the "the agent closed its ACP
   * session between turns" fact — the kimi post-turn/idle close. Keyed on the
   * `session is closed` phrase (in `message` / `details` / serialised `data`),
   * NOT on the bare `-32603` code: that generic "Internal error" code is also
   * used for the adapter's own transient spawn races, so matching it alone would
   * misfire. See {@link SESSION_CLOSED_RE}.
   */
  private isSessionClosedError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { message?: unknown; details?: unknown; data?: unknown };
    const parts: string[] = [];
    if (typeof e.message === 'string') parts.push(e.message);
    if (typeof e.details === 'string') parts.push(e.details);
    if (e.data !== undefined) {
      try {
        parts.push(JSON.stringify(e.data));
      } catch {
        /* circular / non-serialisable — ignore */
      }
    }
    return SESSION_CLOSED_RE.test(parts.join(' '));
  }

  /**
   * Re-establish a session the agent closed out from under us (kimi post-turn),
   * on the SAME still-running adapter process, so the pending prompt can be
   * retried. Prefers `session/load` (resume) when the agent advertised
   * `loadSession` — proven live to re-open kimi's closed session with the
   * conversation context intact. Calls `connection.loadSession` DIRECTLY — the
   * public {@link loadSession} skips a same-id load (a Claude relaunch-wedge
   * guard), which is exactly the load we MUST perform here (the closed id IS the
   * active id). Falls back to a fresh `session/new` (context lost) only when the
   * agent can't resume.
   *
   * ⚠️ kimi's `session/load` (0.23.6, live-verified) REPLAYS the ENTIRE prior
   * conversation as `session/update` notifications BEFORE it resolves — the
   * earlier assumption that it emitted no replay was wrong and caused a P0: the
   * replayed prior-turn text was published as live chunks and prepended to the
   * recovered turn's real reply. So the load is bracketed with
   * `beginLoadReplay()/endLoadReplay()` (wired by the runner to StreamingState)
   * so those replay updates are swallowed, exactly like the baton's load. The
   * retried `session/prompt` (after the load resolves) then streams the REAL new
   * reply cleanly. The `finally` guarantees the guard clears even if the load
   * throws, so a failed recovery can't wedge streaming off.
   */
  /**
   * Start a BRAND-NEW conversation on the SAME running adapter process and make
   * it the active session. Agent Packs' stage boundary: each pipeline role runs
   * in a fresh conversation (fresh context — the reviewer must not see the
   * coder's conversation), so the pack runner calls this between stages instead
   * of respawning the agent. Same `session/new` the startup handshake and
   * {@link reestablishSession} send; callers own re-pointing the history anchor
   * (`AcpHistory.switchActiveSession` + `onActiveSessionChanged`), exactly like
   * the `resume_session` rail.
   */
  async newConversation(opts?: { ensureFullAutoMode?: boolean }): Promise<string> {
    if (!this.connection) {
      throw new Error('AcpClient.newConversation called before start()');
    }
    const ns = await this.connection.newSession({
      cwd: this.opts.cwd,
      mcpServers: this.opts.mcpServers ?? [],
    });
    this.sessionId = ns.sessionId;
    // Re-capture the fresh session's native config — a `session/new` is a
    // brand-new SessionModeState, NOT a clone of the initial session's.
    this.captureModelConfig(ns.configOptions ?? []);
    this.captureModes(ns.modes ?? null);
    // ⚠️ A fresh `session/new` starts in the agent's DEFAULT (ask-per-tool) mode
    // — it does NOT inherit the initial session's `INITIAL_AGENT_MODE=agent-full-
    // access` env (that env is applied by the agent only to its first session).
    // On a managed (codespace / self-hosted, auto-approve) session that means the
    // agent's writes hit an ACP permission prompt with no human to answer → the
    // turn aborts "at the permission layer" and the stage produces no commit
    // (Agent Packs incident, 2026-08-08). Re-assert the agent's full-bypass mode
    // so the fresh conversation behaves identically to the initial session. The
    // caller passes `ensureFullAutoMode` only when the session is managed; a local
    // session leaves the fresh session in its default ask-mode. Best-effort —
    // agents that advertise no matching mode just proceed as before.
    if (opts?.ensureFullAutoMode && this.availableModes.length > 0) {
      const full = this.availableModes.find((m) => modeIsFullAutoApprove(m.id));
      if (full && this.currentModeId !== full.id) {
        try {
          await this.connection.setSessionMode({ sessionId: ns.sessionId, modeId: full.id });
          this.currentModeId = full.id;
          log.info('acpClient', `newConversation → re-asserted full-auto mode ${full.id}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn('acpClient', `newConversation — could not re-assert full-auto mode: ${msg}`);
        }
      }
    }
    log.info('acpClient', `newConversation ← ok sid=${ns.sessionId.slice(0, 8)}`);
    return ns.sessionId;
  }

  private async reestablishSession(): Promise<void> {
    if (!this.connection) throw new Error('AcpClient.reestablishSession: no connection');
    const cwd = this.opts.cwd;
    const mcpServers = this.opts.mcpServers ?? [];
    const closedSid = this.sessionId;
    if (this.supportsLoadSession && closedSid) {
      log.info('acpClient', `reestablish → loadSession(resume) sid=${closedSid.slice(0, 8)}`);
      this.opts.beginLoadReplay?.();
      try {
        await this.connection.loadSession({ sessionId: closedSid, cwd, mcpServers });
      } finally {
        this.opts.endLoadReplay?.();
      }
      // The resumed session keeps the same id — sessionId is unchanged.
      log.info('acpClient', 'reestablish ← loadSession ok');
      return;
    }
    log.info('acpClient', 'reestablish → newSession (agent has no loadSession capability)');
    const ns = await this.connection.newSession({ cwd, mcpServers });
    this.sessionId = ns.sessionId;
    log.info('acpClient', `reestablish ← newSession ok sid=${ns.sessionId.slice(0, 8)}`);
  }

  /**
   * Load a previously persisted session by id. Mobile's
   * `resume_session` command flows through here. Requires the
   * adapter to advertise `loadSession: true` in its initialize
   * response — without that capability the SDK rejects the call.
   *
   * Side-effect: replaces the active sessionId with the loaded one
   * so subsequent prompts target the loaded conversation, not the
   * fresh-on-spawn `newSession` one.
   */
  async loadSession(sessionId: string): Promise<void> {
    if (!this.connection) {
      throw new Error('AcpClient.loadSession called before start()');
    }
    // Self-load guard. Resuming the conversation that is ALREADY the active
    // session (the common case — the user taps the current conversation in the
    // history list) is a no-op semantically, but issuing `session/load` for it
    // is actively harmful: Claude Code resumes by RELAUNCHING with `--resume`
    // (it can't switch into a session it is already running — see
    // claude/runtime.ts), so the adapter tries to relaunch Claude into the
    // session it's already serving and the process wedges — every subsequent
    // `prompt` then hangs 90s with "adapter sent no updates" and the agent
    // appears dead. Skip the redundant RPC; the session is already loaded.
    if (sessionId === this.sessionId) {
      log.info(
        'acpClient',
        `loadSession skipped — already the active session (${sessionId.slice(0, 8)})`,
      );
      return;
    }
    log.info('acpClient', `loadSession → sessionId=${sessionId.slice(0, 8)}`);
    // Swallow the load replay. `session/load` makes Claude replay the ENTIRE
    // prior conversation as `session/update` notifications before it resolves;
    // without this bracket those land as OPEN (`done:false`) streaming chunks
    // that nothing ever closes → mobile shows a stuck "Thinking…"/STOP live turn
    // for history the client already has (the `resume_session` incident). Mirrors
    // reestablishSession() above and the baton driver — the ONLY three callers of
    // session/load; the happy path (fresh session/new at spawn) never calls this,
    // so live streaming for non-resuming users is untouched.
    this.opts.beginLoadReplay?.();
    let loaded: Awaited<ReturnType<ClientSideConnection['loadSession']>> | undefined;
    // Bounded: an adapter that answers neither ok nor error must not hang the
    // caller forever (see LOADSESSION_TIMEOUT_MS). The reject surfaces as a
    // normal thrown error, so every caller's existing failure path runs.
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      loaded = await Promise.race([
        this.connection.loadSession({
          sessionId,
          cwd: this.opts.cwd,
          mcpServers: this.opts.mcpServers ?? [],
        }),
        new Promise<never>((_, reject) => {
          loadTimer = setTimeout(() => {
            const tail = this.recentStderr.slice(-4).join(' | ');
            reject(
              new Error(
                `ACP_LOAD_SESSION_TIMEOUT: ${this.opts.adapter.requiresAgentBinary} did not answer session/load for ${sessionId.slice(
                  0,
                  8,
                )} within ${Math.round(LOADSESSION_TIMEOUT_MS / 1000)}s${
                  tail ? ` — last output: ${tail}` : ''
                }`,
              ),
            );
          }, LOADSESSION_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (loadTimer) clearTimeout(loadTimer);
      this.opts.endLoadReplay?.();
    }
    this.sessionId = sessionId;
    // Re-capture the native model config from the resumed session — the loaded
    // conversation may sit on a different model than the one at spawn, and
    // `loadSession` returns the same `configOptions` shape as `newSession`.
    if (loaded?.configOptions) this.captureModelConfig(loaded.configOptions);
    // Re-capture the native session modes too — the resumed conversation may sit
    // on a different mode than the one at spawn (`loadSession` returns the same
    // `modes` shape as `newSession`).
    if (loaded?.modes !== undefined) this.captureModes(loaded.modes ?? null);
    log.info('acpClient', `loadSession ← ok sessionId=${sessionId.slice(0, 8)}`);
  }

  /** The conversation id the agent is currently serving (null before start). */
  getActiveSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Re-register the agent's MCP servers on an ALREADY-RUNNING session (Session
   * Tools — adding/removing an integration mid-session). MCP servers are bound
   * at `session/new`, and `session/load` on the CURRENTLY-running session wedges
   * Claude (the self-load guard in {@link loadSession}), so the only reliable way
   * to add a server to a live session is a controlled RESPAWN that resumes the
   * conversation: kill the agent → fresh `startOnce()` (a new session S2 bound to
   * the new `mcpServers`) → `loadSession(prevConversationId)` (S1 ≠ S2, so the
   * self-load guard doesn't fire) to resume the thread with the new tools live.
   *
   * Best-effort + degrade-safe: `this.opts.mcpServers` is updated FIRST (so even
   * a failed respawn leaves the new set to bind on the next natural
   * re-establishment — wake/resume/recovery), and any throw resolves to
   * `'deferred'` rather than tearing down the session. Returns which happened so
   * the caller can tell the user "active now" vs "active on next restart".
   */
  async reprovisionMcp(servers: McpServer[]): Promise<'reloaded' | 'deferred'> {
    this.opts.mcpServers = servers;
    if (!this.connection || !this.sessionId) return 'deferred';

    // ⚠️ COALESCE, then run on the PROMPT CHAIN. Two bugs came out of doing
    // neither (live incident 2026-09-02, rafaelph90.br@gmail.com):
    //
    // 1. A burst of integration events — the user linking several connectors in
    //    a row — fired SEVEN respawns in 34 s. Each one `stop()`s the adapter
    //    and `startOnce()`s a new one, with no mutual exclusion, so respawn N+1
    //    SIGKILLed the adapter respawn N had started 500 ms earlier, mid
    //    `initialize`. The log reads:
    //      reprovisionMcp respawn failed — ACP connection closed
    //      adapter exited unexpectedly code=null signal=SIGKILL
    //    and the last one left NO adapter at all, so every later turn died on
    //    "AcpClient.prompt called before start()" — permanently, until the
    //    session was restarted. Only the FINAL server set matters, so a burst
    //    collapses to one respawn.
    //
    // 2. It respawned mid-TURN. The user's "Hola" came back
    //    `stopReason=cancelled` because the respawn killed the agent while it
    //    was answering. `prompt()` already serializes turns through
    //    `promptChain`; joining that chain means a respawn waits for the
    //    in-flight turn instead of cancelling it — and serializes against
    //    other respawns for free, since they share the one queue.
    // DEBOUNCE first (see MCP_REPROVISION_DEBOUNCE_MS): hold the change for a
    // moment so a run of them becomes one respawn instead of one each. Then run
    // on the PROMPT CHAIN, which is what keeps the respawn from cancelling a
    // turn and from racing another respawn.
    //
    // Returning a promise that settles when the respawn does keeps the caller's
    // 'reloaded' | 'deferred' contract intact. Nothing user-facing waits on it:
    // the backend relays `integrations_sync` fire-and-forget (`pushCommand`),
    // and the app already has its answer from the REST call.
    this.mcpReprovisionPending = servers;
    if (this.mcpDebounceTimer) clearTimeout(this.mcpDebounceTimer);

    const settled = new Promise<'reloaded' | 'deferred'>((resolve) => {
      this.mcpDebounceWaiters.push(resolve);
    });

    this.mcpDebounceTimer = setTimeout(() => {
      this.mcpDebounceTimer = null;
      const latest = this.mcpReprovisionPending ?? servers;
      this.mcpReprovisionPending = null;
      const waiters = this.mcpDebounceWaiters;
      this.mcpDebounceWaiters = [];

      const run = this.promptChain.then(() => this.runReprovisionMcp(latest));
      this.promptChain = run.then(
        () => undefined,
        () => undefined,
      );
      run.then(
        (result) => waiters.forEach((w) => w(result)),
        // `runReprovisionMcp` already swallows its own failures into
        // 'deferred'; this is the belt for anything the chain itself throws.
        () => waiters.forEach((w) => w('deferred')),
      );
    }, this.opts.mcpReprovisionDebounceMs ?? MCP_REPROVISION_DEBOUNCE_MS);
    // Never hold the process open for a pending respawn.
    this.mcpDebounceTimer.unref?.();

    return settled;
  }

  /** The actual respawn. Only ever called from {@link reprovisionMcp}'s queued
   *  slot, so it can assume no turn and no other respawn is running. */
  private async runReprovisionMcp(servers: McpServer[]): Promise<'reloaded' | 'deferred'> {
    this.opts.mcpServers = servers;
    const prevConversationId = this.sessionId;
    if (!this.connection || !prevConversationId) return 'deferred';
    try {
      log.info(
        'acpClient',
        `reprovisionMcp → respawn to bind ${servers.length} MCP server(s), resuming ${prevConversationId.slice(0, 8)}`,
      );
      await this.stop();
      this.stopping = false;
      await this.startOnce();
      if (this.supportsLoadSession && prevConversationId !== this.sessionId) {
        await this.loadSession(prevConversationId);
      }
      log.info('acpClient', 'reprovisionMcp ← reloaded (tools live)');
      return 'reloaded';
    } catch (err) {
      log.warn(
        'acpClient',
        `reprovisionMcp respawn failed — tools apply on next restart: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 'deferred';
    }
  }

  /**
   * Enumerate the workspace's conversations via the ACP `session/list` RPC.
   * Agent-agnostic — works for ANY adapter that advertises
   * `sessionCapabilities.list` (claude/codex/gemini alike), so the mobile RECENT
   * list no longer depends on per-agent JSONL scanning. Maps SessionInfo (id +
   * agent-authored title + updatedAt) to the backend's RECENT-list shape.
   *
   * Returns null when the agent doesn't advertise `list` (caller falls back or
   * skips). Best-effort — never throws out to the caller.
   */
  async listSessions(): Promise<Array<{ id: string; summary: string; timestamp: number }> | null> {
    if (!this.connection || !this.supportsListSessions) return null;
    try {
      const res = await this.connection.listSessions({ cwd: this.opts.cwd });
      return (res.sessions ?? []).map((s) => ({
        id: s.sessionId,
        summary: s.title ?? '',
        // updatedAt is an ISO string; fall back to now on absent/unparseable.
        timestamp: s.updatedAt ? Date.parse(s.updatedAt) || Date.now() : Date.now(),
      }));
    } catch (err) {
      log.trace('acpClient', 'listSessions failed (best-effort)', err);
      return null;
    }
  }

  /**
   * Switch the active session's model via the NATIVE ACP
   * `session/set_config_option` RPC, targeting the `category:'model'`
   * `SessionConfigSelect` option captured on newSession/loadSession. This is
   * the single source of truth — there is no PTY `/model` fallback and no
   * non-standard `session/set_model` extension.
   *
   * Throws a clear error when the agent exposes no model config option, so
   * `change_model` acks `failed` and mobile surfaces "model picker not
   * supported on this agent".
   */
  async setModel(modelId: string): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error('AcpClient.setModel called before start()');
    }
    if (!this.modelConfigId) {
      throw new Error(
        'model selection not available: this agent exposes no ACP model config option',
      );
    }
    log.info('acpClient', `setModel → ${modelId} (configId=${this.modelConfigId})`);
    // Typed native RPC (`session/set_config_option`). The select variant of the
    // request is `{ sessionId, configId, value }` — `value` is the model's
    // SessionConfigValueId (= the model id).
    await this.connection.setSessionConfigOption({
      sessionId: this.sessionId,
      configId: this.modelConfigId,
      value: modelId,
    });
    // Track the in-use model so a subsequent list_models reports it as current.
    this.currentModelId = modelId;
    log.info('acpClient', `setModel ← ok modelId=${modelId}`);
  }

  /**
   * The models the agent natively advertises via its `category:'model'` config
   * option (mapped: id = option value, label = option name, contextWindow
   * derived from the id). Empty array when the agent has no model config option
   * — mobile then hides the model selector. NO hardcoded fallback.
   */
  getAvailableModels(): AgentModel[] {
    return this.availableModels;
  }

  /** The native model select's current value (or undefined if none advertised). */
  getCurrentModelId(): string | undefined {
    return this.currentModelId;
  }

  /**
   * Parse the native model config option out of a `newSession`/`loadSession`
   * `configOptions` array and populate {@link modelConfigId},
   * {@link availableModels}, and {@link currentModelId}. The list itself is
   * native (the option's `options`); `contextWindow` is a display attribute
   * derived per-id via {@link getContextWindow}. When no `category:'model'`
   * select option is present, everything resets to empty/undefined — no
   * hardcoded list, no guessed model.
   */
  private captureModelConfig(configOptions: SessionConfigOption[]): void {
    const modelOption = configOptions.find((o) => o.category === 'model' && o.type === 'select');
    if (!modelOption || modelOption.type !== 'select') {
      this.modelConfigId = undefined;
      this.availableModels = [];
      this.currentModelId = undefined;
      return;
    }
    this.modelConfigId = modelOption.id;
    // Same boundary rule as `tier`: an array / object / empty string coming off
    // the wire must read as "no current model", never be stringified into a label.
    this.currentModelId = nonEmptyString(modelOption.currentValue);
    // Filter non-chat models (embeddings, rerankers, …) BEFORE dedupe —
    // agents that expose their provider's whole catalog would otherwise
    // offer `text-embedding-3-large` as a chat model.
    this.availableModels = dedupeModelOptions(
      filterChatModelOptions(
        flattenSelectOptions(modelOption.options).map((opt) => ({
          id: opt.value,
          label: opt.name,
          // Only when it's a real catalog match — native ids are often opaque
          // aliases ("default"/"opus") or proxied (MiniMax house agent), for which a
          // default 200K is a fake; undefined → the UI omits the context sub-label.
          contextWindow: tryGetContextWindow(opt.value),
        })),
        this.currentModelId,
      ),
    );
  }

  /**
   * Switch the active session's operating/permission MODE via the NATIVE ACP
   * `session/set_mode` RPC (the standard {@link SessionModeState} axis — DISTINCT
   * from the model config option). This is the single source of truth — there is
   * no PTY fallback.
   *
   * Throws a clear error when the agent advertises no modes, so `set_mode` acks
   * `failed` and mobile surfaces "mode switching not supported on this agent".
   */
  async setMode(modeId: string): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error('AcpClient.setMode called before start()');
    }
    if (this.availableModes.length === 0) {
      throw new Error('mode selection not available: this agent advertises no ACP session modes');
    }
    log.info('acpClient', `setMode → ${modeId}`);
    // Typed native RPC (`session/set_mode`) — request is `{ sessionId, modeId }`.
    await this.connection.setSessionMode({
      sessionId: this.sessionId,
      modeId,
    });
    // Track the in-use mode so a subsequent list_modes reports it as current.
    this.currentModeId = modeId;
    log.info('acpClient', `setMode ← ok modeId=${modeId}`);
  }

  /**
   * The operating/permission modes the agent natively advertises via its ACP
   * `SessionModeState` (mapped: id = mode id, label = mode name, description
   * passthrough). Empty array when the agent advertises no modes — mobile then
   * hides the mode selector. NO hardcoded fallback.
   */
  getAvailableModes(): AgentMode[] {
    return this.availableModes;
  }

  /** The native current mode id (or undefined if the agent advertises no modes). */
  getCurrentModeId(): string | undefined {
    return this.currentModeId;
  }

  /**
   * Parse the native ACP {@link SessionModeState} out of a `newSession`/`loadSession`
   * response `modes` field and populate {@link availableModes} + {@link currentModeId}.
   * When absent (`null`/undefined — the agent advertises no modes) everything resets
   * to empty/undefined — no hardcoded list, no guessed mode.
   */
  private captureModes(modes: SessionModeState | null): void {
    if (!modes) {
      this.availableModes = [];
      this.currentModeId = undefined;
      return;
    }
    this.currentModeId = modes.currentModeId;
    this.availableModes = (modes.availableModes ?? []).map((mode) => ({
      id: mode.id,
      label: mode.name,
      description: mode.description ?? undefined,
    }));
  }

  /**
   * Cancel the in-flight prompt turn. Notification — no response.
   * Safe to call when nothing is in flight (the adapter no-ops).
   */
  async cancel(): Promise<void> {
    if (!this.connection || !this.sessionId) return;
    await this.connection.cancel({ sessionId: this.sessionId });
  }

  /**
   * Kill the adapter process and tear down the connection. Safe
   * to call multiple times. Suppresses the unexpected-exit
   * callback for this teardown.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    // A respawn waiting out its debounce window must not fire against a client
    // that is being torn down — and its callers must not be left hanging.
    if (this.mcpDebounceTimer) {
      clearTimeout(this.mcpDebounceTimer);
      this.mcpDebounceTimer = null;
      this.mcpReprovisionPending = null;
      const waiters = this.mcpDebounceWaiters;
      this.mcpDebounceWaiters = [];
      waiters.forEach((w) => w('deferred'));
    }
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.connection = null;
    this.sessionId = null;
    try {
      // SIGTERM first — adapters handle it cleanly and flush any
      // pending notifications. Hard kill after 2 s if they hang.
      child.kill('SIGTERM');
      const grace = new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          killQuiet(child, 'SIGKILL');
          resolve();
        }, 2000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
      await grace;
    } catch (err) {
      log.trace('acpClient', 'stop teardown error', err);
    }
  }

  /**
   * Drive the idle watchdog off the tool-call lifecycle so a long but
   * alive tool (typecheck / build / install) can't trip it.
   *
   *   - `tool_call` (a tool starts)             → track + suspend
   *   - `tool_call_update` completed/failed     → untrack; re-arm iff
   *                                               no tool still running
   *   - anything else (thought / message / …)   → re-arm, unless a tool
   *                                               is still outstanding
   */
  private trackToolCallIdle(params: SessionNotification): void {
    const u = params.update as {
      sessionUpdate?: string;
      toolCallId?: string;
      status?: string;
    };
    if (u.sessionUpdate === 'tool_call' && typeof u.toolCallId === 'string') {
      this.pendingToolCalls.add(u.toolCallId);
      this.promptIdle?.suspend();
      return;
    }
    if (
      u.sessionUpdate === 'tool_call_update' &&
      (u.status === 'completed' || u.status === 'failed')
    ) {
      if (typeof u.toolCallId === 'string') this.pendingToolCalls.delete(u.toolCallId);
      this.rearmIdleIfIdle();
      return;
    }
    this.rearmIdleIfIdle();
  }

  /**
   * Re-arm the idle watchdog ONLY when the agent is genuinely idle — no tool
   * call in flight. A pending tool (a `yarn install` / build / test that runs
   * silently for minutes, emitting no `session/update`) is active work, NOT a
   * wedged adapter, so re-arming the 90s window over it would false-kill the
   * turn. Every re-arm MUST route through here so no path can accidentally arm
   * the watchdog while a tool is executing (the 2026-07-10 bug: the
   * auto-approve permission `finally` bumped unconditionally → a ~150s
   * `yarn install` tripped "ACP prompt idle for 90s").
   */
  private rearmIdleIfIdle(): void {
    if (this.pendingToolCalls.size === 0) this.promptIdle?.bump();
  }

  // ─── Client surface (what the agent calls into) ───────────────────

  private buildClient(): Client {
    return {
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        // Tool-call lifecycle drives the idle watchdog: a started tool
        // may run silently for minutes, so suspend while any is pending
        // and only re-arm when the last one settles. All other updates
        // (thoughts, message text, usage) are proof of life → re-arm,
        // unless a tool is still outstanding.
        this.trackToolCallIdle(params);
        this.opts.onSessionUpdate(params);
      },
      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        // The decision is the user's and may take minutes; no
        // `session/update` flows during the wait. Suspend the idle
        // window so the human-in-the-loop pause can't be mistaken for
        // a wedged adapter, then re-arm once they answer.
        this.promptIdle?.suspend();
        try {
          return await this.opts.onRequestPermission(params);
        } finally {
          // Re-arm ONLY if no tool is now executing. Auto-approve resolves in
          // ms and the approved tool is already tracked as pending, so an
          // unconditional bump here re-armed the 90s window OVER a silent
          // long-running tool (the yarn-install false-kill). rearmIdleIfIdle
          // keeps it suspended until the tool actually settles.
          this.rearmIdleIfIdle();
        }
      },
      readTextFile: async (params): Promise<ReadTextFileResponse> => {
        // ACP guarantees `path` is absolute. Out-of-tree reads are
        // the agent's responsibility — we trust the adapter's
        // sandboxing (claude-agent-acp / codex-acp scope to the
        // session cwd by default).
        //
        // Map filesystem errors to the SDK's typed RequestError so
        // the adapter can branch on the JSON-RPC error code. Without
        // this, a bare `fs.readFile` ENOENT bubbles up as a generic
        // `-32603 Internal error` which Gemini interprets as
        // "transient failure, retry" — it then re-tries the same
        // read in a tight loop and the prompt times out at 90 s
        // (caught in the v2.27.11 smoke test). `resourceNotFound`
        // (-32002) is the spec-correct shape for "this path doesn't
        // exist"; the adapter's read-before-write check sees it and
        // falls through to the write branch immediately.
        // CodeAgent internals guard (MANAGED deploys only): refuse a delegated
        // read of a platform-internal path (~/.codeam, ~/.beads, house-claude,
        // host log). -32002 (resource error) is the same shape the adapter
        // already handles for permission-denied, so it degrades cleanly instead
        // of exposing the file. Not applied locally (there it's the user's own).
        if (!isLocalSession() && pathIsInternal(params.path)) {
          throw new RequestError(-32002, INTERNAL_BLOCK_REASON, { uri: params.path });
        }
        // Guardrail belt (MANAGED only): the fs seam has no interactive channel,
        // so it enforces secretRead only when set to `deny` (a delegated read of
        // a .env/key/credential file). `confirm`/`off` there degrade to allow —
        // the primary secretRead enforcement is the permission-request path.
        if (
          !isLocalSession() &&
          getGuardrailPolicy().secretRead === 'deny' &&
          toolPathIsSecret(params.path)
        ) {
          throw new RequestError(-32002, GUARDRAIL_SECRET_READ_BLOCK_REASON, { uri: params.path });
        }
        try {
          const content = await fs.readFile(params.path, 'utf8');
          return applyLineRange(content, params.line ?? null, params.limit ?? null);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') throw RequestError.resourceNotFound(params.path);
          if (code === 'EACCES' || code === 'EPERM') {
            throw new RequestError(-32002, `Permission denied: ${params.path}`, {
              uri: params.path,
            });
          }
          if (code === 'EISDIR') {
            throw RequestError.invalidParams(`path is a directory: ${params.path}`);
          }
          throw RequestError.internalError({ uri: params.path }, code ?? String(err));
        }
      },
      writeTextFile: async (params): Promise<WriteTextFileResponse> => {
        // Internals guard (MANAGED only) — also refuse WRITES into platform
        // paths so a turn can't tamper with CodeAgent's own runtime config.
        if (!isLocalSession() && pathIsInternal(params.path)) {
          throw new RequestError(-32002, INTERNAL_BLOCK_REASON, { uri: params.path });
        }
        try {
          await fs.writeFile(params.path, params.content, 'utf8');
          return {};
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'EACCES' || code === 'EPERM') {
            throw new RequestError(-32002, `Permission denied: ${params.path}`, {
              uri: params.path,
            });
          }
          if (code === 'ENOENT') {
            // Parent directory missing — distinct from "file not
            // found" semantically; the adapter sees this and knows
            // to mkdir before retrying instead of giving up.
            throw RequestError.invalidParams(`Parent directory does not exist for: ${params.path}`);
          }
          throw RequestError.internalError({ uri: params.path }, code ?? String(err));
        }
      },
      // Terminal capability is declared `false` above so adapters
      // shouldn't call these; provide explicit "not implemented"
      // stubs so a misbehaving adapter gets a clean error instead
      // of a hung promise.
      createTerminal: async (): Promise<CreateTerminalResponse> => {
        throw new Error('terminal capability not implemented in this client (Phase 1)');
      },
      terminalOutput: async (): Promise<TerminalOutputResponse> => {
        throw new Error('terminal capability not implemented in this client (Phase 1)');
      },
      releaseTerminal: async (): Promise<ReleaseTerminalResponse> => {
        throw new Error('terminal capability not implemented in this client (Phase 1)');
      },
      waitForTerminalExit: async (): Promise<WaitForTerminalExitResponse> => {
        throw new Error('terminal capability not implemented in this client (Phase 1)');
      },
      killTerminal: async (): Promise<KillTerminalResponse> => {
        throw new Error('terminal capability not implemented in this client (Phase 1)');
      },
    };
  }
}

/**
 * Flatten a native `SessionConfigSelectOptions` — which is EITHER a flat
 * `SessionConfigSelectOption[]` OR a grouped `SessionConfigSelectGroup[]` — into
 * a single option list. Groups (e.g. "Anthropic" / "OpenAI" headers) are UX-only
 * for the model picker; the CLI presents one flat model list to mobile, so we
 * splice each group's `options` in. Exported for the client-level unit test.
 */
export function flattenSelectOptions(
  options: SessionConfigSelectOptions,
): SessionConfigSelectOption[] {
  const out: SessionConfigSelectOption[] = [];
  for (const entry of options as Array<SessionConfigSelectOption | SessionConfigSelectGroup>) {
    if ('group' in entry) {
      out.push(...entry.options);
    } else {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Narrow an unvalidated wire value to a non-empty string, or `undefined`.
 *
 * The ACP payloads are typed through casts at a few legacy/non-standard fields
 * (`currentServiceTier`, `currentValue`), so TypeScript never catches an
 * adapter that sends an array or an object. Those values then get `String()`-
 * coerced into a display template — which is exactly how the welcome card ended
 * up reading `Cursor Agent · default[]`.
 */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Collapse a native model list into one the user can actually choose from.
 *
 * Two distinct defects, both observed live on OpenCode's "Switch Model" sheet
 * (which listed "MiniMax-M3" THREE times):
 *
 *  1. **Repeated ids.** `flattenSelectOptions` splices every group's options
 *     into one flat list, and agents that expose the same model under several
 *     provider groups then emit the SAME `value` more than once. Those rows are
 *     literally the same choice — the first one wins, the rest are dropped.
 *  2. **Repeated labels on DIFFERENT ids.** Genuinely distinct models can share
 *     a display name (the same model reached through two providers/proxies).
 *     Dropping one would lose a real choice, so instead the colliding rows are
 *     qualified with their id — the user sees three DISTINGUISHABLE rows rather
 *     than three identical ones.
 *
 * Order is preserved (the agent's own ordering is meaningful) and no model is
 * ever invented. Exported pure so it can be unit-tested without a live adapter.
 */
/**
 * Non-chat model detector — id/label patterns for models that can never
 * drive a coding-agent conversation. Some agents (opencode) advertise their
 * provider's ENTIRE catalog as the ACP model select, embeddings included:
 * a live Switch Model sheet offered `OpenAI/text-embedding-3-large`
 * `/-small` `/-ada-002` as selectable chat models (2026-08-19 replay wave,
 * user caigicungdc98, recording B f108_0254s). `AgentModel` carries no
 * capability metadata, so this is a conservative NAME denylist —
 * embeddings, rerankers, moderation, speech (tts/whisper/transcribe) and
 * pure image models. Anything not clearly non-chat is kept.
 */
const NON_CHAT_MODEL_PATTERNS: RegExp[] = [
  /\bembed(?:ding)?s?\b/i, // text-embedding-3-large, *-embed-*, embeddings
  /\brerank(?:er|ing)?\b/i,
  /\bmoderation\b/i,
  /\btts\b/i,
  /\bwhisper\b/i,
  /\btranscribe\b/i,
  /\bdall-?e\b/i,
];

/**
 * Drop models the user could never chat with. The model the agent reports
 * as CURRENT is never dropped — if the agent really is running it, hiding
 * it would desync the client's ✓ from reality. Exported pure for unit
 * tests; the mobile store applies the same guard for sessions on older
 * CLIs (`sessionModel.store.ts` `filterChatModels`).
 */
export function filterChatModelOptions(
  models: AgentModel[],
  currentModelId?: string,
): AgentModel[] {
  return models.filter(
    (m) =>
      m.id === currentModelId ||
      !NON_CHAT_MODEL_PATTERNS.some((re) => re.test(`${m.id} ${m.label}`)),
  );
}

export function dedupeModelOptions(models: AgentModel[]): AgentModel[] {
  const seen = new Set<string>();
  const unique: AgentModel[] = [];
  for (const m of models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    unique.push(m);
  }

  const labelCounts = new Map<string, number>();
  for (const m of unique) labelCounts.set(m.label, (labelCounts.get(m.label) ?? 0) + 1);

  return unique.map((m) =>
    (labelCounts.get(m.label) ?? 0) > 1 && m.label !== m.id
      ? { ...m, label: `${m.label} (${m.id})` }
      : m,
  );
}

/**
 * Slice file content to the `line` + `limit` window the agent
 * requested. ACP uses 1-based line numbers and inclusive `limit`
 * semantics (i.e. `limit: 50` returns 50 lines). When neither is
 * set we return the full file.
 *
 * Exported for the unit tests — keeps the slicing logic out of
 * the spawned-process path.
 */
export function applyLineRange(
  content: string,
  line: number | null,
  limit: number | null,
): ReadTextFileResponse {
  if (line === null && limit === null) return { content };
  const lines = content.split('\n');
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit !== null ? start + limit : lines.length;
  return { content: lines.slice(start, end).join('\n') };
}

/**
 * Common locations where a global agent binary (gemini, claude,
 * codex, etc.) might be installed on a developer's machine.
 * Returned in priority order — the FIRST match for any given
 * binary name wins on PATH lookup.
 *
 * The list covers:
 *   - codeam's bundled node tree (`/tmp/codeam-node20/bin`) — set
 *     by the codespace bootstrap.
 *   - Codespace / Devcontainer images: `/usr/local/share/nvm/versions/node/<ver>/bin`.
 *   - User-installed nvm: `$HOME/.nvm/versions/node/<ver>/bin`.
 *   - System npm prefixes: `/usr/local/bin`, `/usr/bin`.
 *   - User XDG bin: `$HOME/.local/bin`, `$HOME/bin`.
 *   - Volta shims: `$HOME/.volta/bin`.
 *
 * Listing a directory that doesn't exist is harmless — `existsSync`
 * filters cleanly. We do NOT depend on globbing or async glob libs
 * here; `readdirSync` on the nvm parent is enough.
 */
function knownAgentBinaryDirs(): string[] {
  const home = os.homedir();
  const out: string[] = [];

  // codeam's own bundled tree (always wins so the symlink + override
  // pattern keeps working).
  out.push('/tmp/codeam-node20/bin');

  // System nvm trees (Codespaces / Devcontainers).
  for (const root of [
    '/usr/local/share/nvm/versions/node',
    path.join(home, '.nvm/versions/node'),
  ]) {
    try {
      for (const child of fsSync.readdirSync(root)) {
        out.push(path.join(root, child, 'bin'));
      }
    } catch {
      // dir doesn't exist — skip silently.
    }
  }

  // Voltage + Volta shims (uncommon but covers vendor managers).
  out.push(path.join(home, '.volta/bin'));

  // Static well-known dirs.
  out.push('/usr/local/bin');
  out.push('/usr/bin');
  out.push(path.join(home, '.local/bin'));
  out.push(path.join(home, 'bin'));

  // Every supported agent's KNOWN installer target dir — the canonical list
  // shared with the probe-side `augmentUserLocalBinPaths` (agent-binary.ts).
  // Load-bearing for spawns that never ran a `waitForBinary` probe: the
  // supervisor's post-restart auto-resume spawned `kimi acp` with a bare
  // systemd PATH and died ENOENT even though kimi was installed at
  // `~/.kimi-code/bin` (fleet-1, 2026-08-20). Folding the vendor dirs in HERE
  // — the one place every ACP adapter spawn goes through — fixes the class
  // for all agents, not just whichever probe path happened to run first.
  out.push(...agentInstallBinDirs());

  // Windows: agent CLIs install under the user profile, and their
  // installers update the *User* PATH (setx) — which a long-running
  // process never inherits. Probe the deterministic dirs directly so a
  // bare-name spawn still resolves. (cursor-agent additionally resolves
  // by absolute path in its adapter; this covers the fallback + npm-global.)
  if (process.platform === 'win32') {
    const { LOCALAPPDATA, APPDATA } = process.env;
    if (LOCALAPPDATA) out.push(path.join(LOCALAPPDATA, 'cursor-agent'));
    if (APPDATA) out.push(path.join(APPDATA, 'npm'));
  }

  return out.filter((p) => {
    try {
      return fsSync.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Prepend known agent-binary directories to an existing PATH.
 * Idempotent — directories already in `existingPath` are not
 * duplicated, so calling this on an already-expanded PATH is a
 * no-op. Exported for test coverage; production callers use it
 * through {@link AcpClient.start}.
 */
export function expandPathForAgentBinaries(existingPath: string): string {
  const existing = new Set(existingPath.split(path.delimiter).filter((p) => p.length > 0));
  const additions: string[] = [];
  for (const dir of knownAgentBinaryDirs()) {
    if (!existing.has(dir)) {
      additions.push(dir);
      existing.add(dir);
    }
  }
  if (additions.length === 0) return existingPath;
  return [...additions, existingPath].filter((p) => p.length > 0).join(path.delimiter);
}
