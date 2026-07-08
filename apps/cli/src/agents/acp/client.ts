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
import type { PromptBlock } from './buildAcpPromptBlocks';
import { createIdleTimeout, type IdleTimeout } from './idleTimeout';
import { log } from '../../services/logger';
import { killQuiet } from '../../lib/quiet';

/**
 * Protocol version we advertise during `initialize`. ACP v1 is the
 * stable line; the SDK accepts a numeric major version per its
 * type. Bumping this in the future is a one-liner change.
 */
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
  /** Last few adapter stderr lines — so a startup failure surfaces the REAL
   *  cause (e.g. gemini's `IneligibleTierError`) instead of a bare timeout. */
  private recentStderr: string[] = [];
  /** Set while `newSession` is in flight; the stderr watcher calls it to fail
   *  fast when the adapter prints a fatal startup error. `gemini --acp`
   *  swallows the Code Assist onboarding error and never rejects `newSession`,
   *  so without this the session hangs forever ("loading… / offline"). */
  private startupFailureReject: ((err: Error) => void) | null = null;

  constructor(private readonly opts: AcpClientOptions) {}

  /**
   * Spawn the adapter + perform the initial handshake (initialize
   * → newSession). Returns the ACP-assigned sessionId so the caller
   * can route subsequent prompts, plus optional model + tier that
   * some adapters (codex-acp today) surface on the newSession
   * response — used by the runner to enrich the welcome card
   * subtitle without an extra round-trip.
   */
  async start(): Promise<{
    sessionId: string;
    initialize: InitializeResponse;
    /** Adapter-picked model id, e.g. `gpt-5`. `undefined` when the
     *  adapter doesn't expose `currentModelId` on newSession
     *  (claude-agent-acp + gemini --acp today). */
    model?: string;
    /** Plan / service tier label the adapter advertises (`plus`,
     *  `pro`, `team`, …). Same nullability as `model`. */
    tier?: string;
  }> {
    if (this.child) throw new Error('AcpClient already started');

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

      log.info('acpClient', 'initialize → sending');
      const initialize = await this.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: CLIENT_CAPABILITIES,
      });
      log.info(
        'acpClient',
        `initialize ← ok protocolVersion=${initialize.protocolVersion} agentCaps=${JSON.stringify(initialize.agentCapabilities ?? {}).slice(0, 200)}`,
      );

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
          this.connection.newSession({ cwd, mcpServers: [] }),
          startupFailure,
        ]);
      } finally {
        if (startupTimer) clearTimeout(startupTimer);
        this.startupFailureReject = null;
      }
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
      mcpServers: [],
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
      if (this.pendingToolCalls.size === 0) this.promptIdle?.bump();
      return;
    }
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
          this.promptIdle?.bump();
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
