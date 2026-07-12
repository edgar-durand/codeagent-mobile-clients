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
  type SessionNotification,
  type TerminalOutputResponse,
  type WaitForTerminalExitResponse,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import type { AdapterSpec } from './adapters';
import { ADAPTER_MODULE_LOAD_ERROR_RE } from './agent-binary';
import type { PromptBlock } from './buildAcpPromptBlocks';
import { createIdleTimeout, type IdleTimeout } from './idleTimeout';
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
  /** Adapter-picked model id, e.g. `gpt-5`. `undefined` when the adapter
   *  doesn't expose `currentModelId` on newSession (claude-agent-acp + gemini). */
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
   * not set after the fact. Empty/omitted by default.
   */
  extraEnv?: Record<string, string>;
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
  onRequestPermission: (
    request: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;
  /** Called on adapter stderr lines for debugging — log surface
   *  the caller owns so we don't have to pick stdout vs stderr
   *  semantics here. */
  onStderr?: (line: string) => void;
  /** Called when the adapter process exits unexpectedly so the
   *  caller can tear down the session. Not called on a normal
   *  `stop()` shutdown. */
  onUnexpectedExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export class AcpClient {
  private child: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private stopping = false;
  private sessionId: string | null = null;
  /** Whether the agent advertised `loadSession` on `initialize`. Drives the
   *  post-turn session-closed recovery: an agent that supports resume (kimi,
   *  claude, codex, gemini) is re-established with `session/load` — preserving
   *  the conversation — whereas one without it falls back to a fresh
   *  `session/new`. Set once during {@link startOnce}. */
  private supportsLoadSession = false;
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

      this.connection = new ClientSideConnection(
        (_agent: Agent) => this.buildClient(),
        stream,
      );

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
      // Log the adapter-picked model so account-mismatch bugs (e.g.
      // codex-acp defaulting to a model the user's account doesn't
      // include) are immediately visible in the smoke-test log
      // instead of surfacing as a cryptic "Authentication required"
      // or "model not supported" error from the prompt response.
      const newSessionMeta = newSession as unknown as {
        currentModelId?: string;
        currentServiceTier?: string;
      };
      log.info(
        'acpClient',
        `newSession ← ok sessionId=${newSession.sessionId.slice(0, 8)}` +
          ` model=${newSessionMeta.currentModelId ?? '?'}` +
          ` tier=${newSessionMeta.currentServiceTier ?? '?'}`,
      );

      return {
        sessionId: newSession.sessionId,
        initialize,
        model: newSessionMeta.currentModelId,
        tier: newSessionMeta.currentServiceTier,
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
    if (!this.connection || !this.sessionId) {
      throw new Error('AcpClient.prompt called before start()');
    }
    // Normalise: plain string callers (slash commands, free-form
    // replies) shouldn't have to build a single-block array; the
    // start_task path with image attachments passes the array directly
    // so it can interleave `image` + `text` blocks.
    const blocks: PromptBlock[] =
      typeof input === 'string'
        ? [{ type: 'text', text: input }]
        : (input as PromptBlock[]);
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
    const textLen = blocks.reduce(
      (n, b) => (b.type === 'text' ? n + b.text.length : n),
      0,
    );
    const imageCount = blocks.reduce(
      (n, b) => (b.type === 'image' ? n + 1 : n),
      0,
    );
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
          `ACP prompt idle for ${PROMPT_IDLE_TIMEOUT_MS / 1000}s — adapter sent no updates. ` +
            `Likely the underlying agent's auth or network is misconfigured; check the adapter stderr ` +
            `lines above (acpAdapter tag) for the actual error.`,
        ),
    );
    this.promptIdle = idle;
    // Fresh tool-call ledger per turn so a stale entry from a prior
    // turn can't keep this turn's watchdog suspended forever.
    this.pendingToolCalls.clear();
    try {
      const result = await Promise.race([send, idle.promise]);
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
   * conversation context intact, and kimi's `session/load` emits NO history
   * replay as `session/update`, so no streaming pollution (unlike the baton's
   * Claude load, which is why this needs no `beginLoadReplay` bracket). Calls
   * `connection.loadSession` DIRECTLY — the public {@link loadSession} skips a
   * same-id load (a Claude relaunch-wedge guard), which is exactly the load we
   * MUST perform here (the closed id IS the active id). Falls back to a fresh
   * `session/new` (context lost) only when the agent can't resume.
   */
  private async reestablishSession(): Promise<void> {
    if (!this.connection) throw new Error('AcpClient.reestablishSession: no connection');
    const cwd = this.opts.cwd;
    const mcpServers = this.opts.mcpServers ?? [];
    const closedSid = this.sessionId;
    if (this.supportsLoadSession && closedSid) {
      log.info('acpClient', `reestablish → loadSession(resume) sid=${closedSid.slice(0, 8)}`);
      await this.connection.loadSession({ sessionId: closedSid, cwd, mcpServers });
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
    await this.connection.loadSession({
      sessionId,
      cwd: this.opts.cwd,
      mcpServers: this.opts.mcpServers ?? [],
    });
    this.sessionId = sessionId;
    log.info('acpClient', `loadSession ← ok sessionId=${sessionId.slice(0, 8)}`);
  }

  /**
   * Switch the active session's model via the non-standard
   * `session/set_model` RPC. The standard ACP SDK doesn't expose
   * this — claude-agent-acp and codex-acp implement it as an
   * extension. Adapters without it reject and `change_model`
   * surfaces a clean "not supported" affordance on mobile.
   */
  async setModel(modelId: string): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error('AcpClient.setModel called before start()');
    }
    log.info('acpClient', `setModel → ${modelId}`);
    // Use the SDK's raw request escape hatch — sendRequest sits
    // below the typed RPC layer, so non-standard methods like
    // `session/set_model` route through without typed-shape friction.
    const rawConn = this.connection as unknown as {
      connection: {
        sendRequest: (method: string, params: unknown) => Promise<unknown>;
      };
    };
    await rawConn.connection.sendRequest('session/set_model', {
      sessionId: this.sessionId,
      modelId,
    });
    log.info('acpClient', `setModel ← ok modelId=${modelId}`);
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
        try {
          const content = await fs.readFile(params.path, 'utf8');
          return applyLineRange(content, params.line ?? null, params.limit ?? null);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') throw RequestError.resourceNotFound(params.path);
          if (code === 'EACCES' || code === 'EPERM') {
            throw new RequestError(
              -32002,
              `Permission denied: ${params.path}`,
              { uri: params.path },
            );
          }
          if (code === 'EISDIR') {
            throw RequestError.invalidParams(`path is a directory: ${params.path}`);
          }
          throw RequestError.internalError({ uri: params.path }, code ?? String(err));
        }
      },
      writeTextFile: async (params): Promise<WriteTextFileResponse> => {
        try {
          await fs.writeFile(params.path, params.content, 'utf8');
          return {};
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'EACCES' || code === 'EPERM') {
            throw new RequestError(
              -32002,
              `Permission denied: ${params.path}`,
              { uri: params.path },
            );
          }
          if (code === 'ENOENT') {
            // Parent directory missing — distinct from "file not
            // found" semantically; the adapter sees this and knows
            // to mkdir before retrying instead of giving up.
            throw RequestError.invalidParams(
              `Parent directory does not exist for: ${params.path}`,
            );
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
  const existing = new Set(
    existingPath.split(path.delimiter).filter((p) => p.length > 0),
  );
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
