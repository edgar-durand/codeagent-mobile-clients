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
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  RequestError,
  ndJsonStream,
  type Agent,
  type Client,
  type ContentBlock,
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
import { log } from '../../services/logger';

/**
 * Protocol version we advertise during `initialize`. ACP v1 is the
 * stable line; the SDK accepts a numeric major version per its
 * type. Bumping this in the future is a one-liner change.
 */
const PROTOCOL_VERSION = 1;

/**
 * Ceiling for a single `session/prompt` round-trip. Sized to a value
 * Claude can plausibly need for a long reasoning turn (90 s ≫ typical
 * Sonnet response) so we don't false-trip on slow legitimate work,
 * but small enough that a silently-stuck adapter doesn't strand the
 * relay command forever. Mobile sees the timeout as a normal
 * "failed" command result, not a permanent "Thinking…" spinner.
 */
const PROMPT_TIMEOUT_MS = 90_000;

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

export interface AcpPromptInput {
  content: ContentBlock[];
  textForLog?: string;
}

export interface AcpClientOptions {
  /** Spec resolved from {@link getAcpAdapter}. */
  adapter: AdapterSpec;
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
    log.info(
      'acpClient',
      `spawn cmd=${adapter.command} args=[${adapter.args.join(',')}] cwd=${cwd}`,
    );
    const child = spawn(adapter.command, adapter.args, {
      cwd,
      env: process.env,
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
        }
      }
    });

    child.on('exit', (code, signal) => {
      if (this.stopping) return;
      log.warn('acpClient', `adapter exited unexpectedly code=${code} signal=${signal}`);
      this.opts.onUnexpectedExit?.(code, signal);
    });

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
    const newSession = await this.connection.newSession({
      cwd,
      mcpServers: [],
    });
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
  async prompt(input: string | AcpPromptInput): Promise<PromptResponse> {
    if (!this.connection || !this.sessionId) {
      throw new Error('AcpClient.prompt called before start()');
    }
    const content = typeof input === 'string'
      ? [{ type: 'text', text: input } satisfies ContentBlock]
      : input.content;
    const textForLog = typeof input === 'string'
      ? input
      : (input.textForLog ?? content
        .map((block) => {
          const maybeText = block as { type?: string; text?: unknown };
          return maybeText.type === 'text' && typeof maybeText.text === 'string'
            ? maybeText.text
            : '';
        })
        .join(''));
    log.info(
      'acpClient',
      `prompt → session=${this.sessionId.slice(0, 8)} chars=${textForLog.length} blocks=${content.length}`,
    );
    const t0 = Date.now();
    const send = this.connection.prompt({
      sessionId: this.sessionId,
      prompt: content,
    });

    // Bare setTimeout + manual cleanup instead of the
    // `void send.finally(() => clearTimeout(id))` pattern, which
    // leaked an unhandled rejection when `send` rejected (the
    // discarded .finally() promise carries the same rejection,
    // and Node 15+ kills the process on strict-unhandled). Caught
    // by the v2.27.9 codex smoke test — the auth-error rejection
    // crashed the runner before its own try/catch could ack the
    // command.
    let timeoutId: NodeJS.Timeout | undefined;
    const timeout = new Promise<PromptResponse>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new Error(
            `ACP prompt timed out after ${PROMPT_TIMEOUT_MS / 1000}s — adapter never responded. ` +
              `Likely the underlying agent's auth or network is misconfigured; check the adapter stderr ` +
              `lines above (acpAdapter tag) for the actual error.`,
          ),
        );
      }, PROMPT_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([send, timeout]);
      log.info(
        'acpClient',
        `prompt ← ok stopReason=${result.stopReason ?? '?'} elapsedMs=${Date.now() - t0}`,
      );
      return result;
    } catch (err) {
      log.warn(
        'acpClient',
        `prompt ← failed elapsedMs=${Date.now() - t0} err=${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    } finally {
      // Always clear the timer so the timeout promise can't fire
      // later and try to reject after we've already moved on.
      if (timeoutId !== undefined) clearTimeout(timeoutId);
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
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
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

  // ─── Client surface (what the agent calls into) ───────────────────

  private buildClient(): Client {
    return {
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        this.opts.onSessionUpdate(params);
      },
      requestPermission: (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        return this.opts.onRequestPermission(params);
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
