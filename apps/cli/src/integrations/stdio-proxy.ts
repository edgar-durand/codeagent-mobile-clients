// src/integrations/stdio-proxy.ts
//
// A restartable, line-delimited JSON-RPC pass-through between the parent's
// stdin/stdout and a spawned child MCP server. Used by `codeam mcp-run <id>`
// to keep an integration's short-lived broker token fresh without the
// agent's MCP client ever seeing a hiccup: when the token is near expiry AND
// there is no in-flight request, the child is killed, respawned with a
// freshly-fetched token (via `spawnSpec()`), and the ORIGINAL `initialize`
// request is replayed to it under a sentinel id (so the new child's session
// state matches what the agent already negotiated) — the response to the
// sentinel is swallowed (the agent already has its initialize response) and
// a `notifications/initialized` is sent to complete the handshake. Client
// lines that arrive mid-swap are buffered and flushed once the new child is
// ready, so nothing is lost or reordered.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';

export interface ProxyChildSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface Opts {
  /** Called per (re)spawn — fetches a FRESH token. */
  spawnSpec: () => Promise<ProxyChildSpec>;
  /** True when the current token is near expiry and a swap should happen. */
  shouldRestartNow: () => boolean;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  spawnImpl?: typeof nodeSpawn;
}

const RESTART_CHECK_INTERVAL_MS = 30_000;

/** Grace before escalating a swapped-out child from SIGTERM to SIGKILL. */
const SIGKILL_ESCALATION_MS = 2_000;

/**
 * Hard ceiling on a single `tools/call`. A wrapped MCP server can hang
 * INDEFINITELY on a tool — e.g. Convex's `tables`/`data`/`functionSpec` open a
 * live connection to a *dev* deployment that only answers while `convex dev` is
 * running, and never return otherwise. With no response the agent's turn wedges
 * forever with NO Stop button (2026-08-03 Rafael incident). On timeout we
 * synthesize a JSON-RPC error for that request id so the agent unblocks with a
 * clean tool error instead of hanging. Legit long tools (big queries, installs)
 * finish well under this; overridable via `CODEAM_MCP_TOOL_TIMEOUT_MS` for an
 * outlier server.
 */
export const TOOL_CALL_TIMEOUT_MS = (() => {
  const raw = Number(process.env.CODEAM_MCP_TOOL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
})();

/**
 * Sentinel id used when replaying the recorded `initialize` to a freshly
 * swapped-in child. MCP clients recycle numeric request ids across a session,
 * so replaying under the CLIENT's original id risks swallowing a legitimate
 * later response that reuses it. The sentinel can never collide with a
 * client-issued id, so the swallow is positively identified.
 */
const REPLAY_INIT_ID = '__codeam_replay_init__';

export class RestartableStdioProxy {
  private child: ChildProcess | null = null;
  private childRl: readline.Interface | null = null;
  private initializeLine: string | null = null;
  private inflight = new Set<string | number>();
  /** Per-`tools/call` request-id watchdog timers (see TOOL_CALL_TIMEOUT_MS). */
  private toolTimers = new Map<string | number, NodeJS.Timeout>();
  private stdout: NodeJS.WritableStream | null = null;
  private swapping = false;
  private pendingClientLines: string[] = [];
  private ended: (code: number) => void = () => undefined;

  constructor(private readonly opts: Opts) {}

  async start(): Promise<void> {
    const stdin = this.opts.stdin ?? process.stdin;
    const stdout = this.opts.stdout ?? process.stdout;
    this.stdout = stdout;
    await this.spawnChild(stdout);

    const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });
    rl.on('line', (line) => this.onClientLine(line));
    rl.on('close', () => this.child?.stdin?.end());

    const timer = setInterval(() => this.checkRestart(stdout), RESTART_CHECK_INTERVAL_MS);
    timer.unref();

    return new Promise<void>((resolve) => {
      this.ended = (code) => {
        clearInterval(timer);
        process.exitCode = code;
        resolve();
      };
    });
  }

  private onClientLine(line: string): void {
    if (this.swapping) {
      this.pendingClientLines.push(line);
      return;
    }
    try {
      const msg = JSON.parse(line) as {
        method?: string;
        id?: string | number;
        params?: { requestId?: string | number };
      };
      if (msg.method === 'initialize' && this.initializeLine === null) {
        this.initializeLine = line;
      }
      if (msg.method === 'notifications/cancelled') {
        // Per MCP, the server SHOULD NOT reply to a cancelled request — so no
        // response will ever decrement it. Without this, the cancelled id
        // pins `inflight` > 0 forever and blocks every future token-refresh
        // restart for the rest of the session.
        const requestId = msg.params?.requestId;
        if (requestId !== undefined) {
          this.inflight.delete(requestId);
          this.clearToolTimeout(requestId);
        }
      }
      if (msg.id !== undefined && msg.method !== undefined) {
        this.inflight.add(msg.id);
        // Only `tools/call` gets a watchdog — a hung tool is the wedge case;
        // `initialize`/`tools/list`/etc. are fast handshake calls.
        if (msg.method === 'tools/call') this.armToolTimeout(msg.id);
      }
    } catch {
      /* forward non-JSON verbatim */
    }
    this.child?.stdin?.write(line + '\n');
  }

  private onChildLine(line: string, stdout: NodeJS.WritableStream): void {
    try {
      const msg = JSON.parse(line) as { id?: string | number; method?: string };
      if (msg.id !== undefined && msg.method === undefined) {
        if (msg.id === REPLAY_INIT_ID) {
          return; // response to OUR replayed initialize: the client already has one
        }
        this.inflight.delete(msg.id);
        this.clearToolTimeout(msg.id);
      }
    } catch {
      /* forward verbatim */
    }
    stdout.write(line + '\n');
    if (this.inflight.size === 0) this.checkRestart(stdout);
  }

  /**
   * Arm a per-`tools/call` watchdog. If the server never answers this request
   * id within {@link TOOL_CALL_TIMEOUT_MS}, synthesize a JSON-RPC error response
   * to the client so the agent's turn unblocks (clean tool error) instead of
   * hanging forever with no Stop. Idempotent per id.
   */
  private armToolTimeout(id: string | number): void {
    const existing = this.toolTimers.get(id);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.toolTimers.delete(id);
      if (!this.inflight.has(id)) return; // already answered — nothing to do
      this.inflight.delete(id);
      process.stderr.write(
        `[codeam mcp-run] tools/call id=${String(id)} timed out after ${TOOL_CALL_TIMEOUT_MS}ms — server did not respond; failing the call so the turn can proceed\n`,
      );
      const errResponse = {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32001,
          message:
            `MCP tool call timed out after ${Math.round(TOOL_CALL_TIMEOUT_MS / 1000)}s — the server did not respond. ` +
            `The target service/deployment may be unreachable (e.g. a Convex dev deployment is only reachable while \`convex dev\` is running — use a production deploy key or start \`convex dev\`).`,
        },
      };
      (this.stdout ?? process.stdout).write(JSON.stringify(errResponse) + '\n');
    }, TOOL_CALL_TIMEOUT_MS);
    t.unref();
    this.toolTimers.set(id, t);
  }

  private clearToolTimeout(id: string | number): void {
    const t = this.toolTimers.get(id);
    if (t) {
      clearTimeout(t);
      this.toolTimers.delete(id);
    }
  }

  private clearAllToolTimeouts(): void {
    for (const t of this.toolTimers.values()) clearTimeout(t);
    this.toolTimers.clear();
  }

  /**
   * Failsafe wrapper for the fire-and-forget call sites (post-response check
   * + the 30 s timer): `maybeRestart` handles the token-fetch failure itself,
   * but nothing that escapes it may become an unhandled rejection — that
   * would kill the whole shim process.
   */
  private checkRestart(stdout: NodeJS.WritableStream): void {
    this.maybeRestart(stdout).catch((err) => {
      process.stderr.write(
        `[codeam mcp-run] restart check failed (will retry): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  }

  private async maybeRestart(stdout: NodeJS.WritableStream): Promise<void> {
    if (this.swapping || !this.opts.shouldRestartNow()) return;
    if (this.inflight.size > 0 || this.initializeLine === null || !this.child) return;
    this.swapping = true;
    // Fetch the fresh token/spec BEFORE tearing anything down: if the broker
    // is unreachable, the healthy old child must keep serving (its token is
    // near expiry, not expired) and the next opportunistic check retries.
    let spec: ProxyChildSpec;
    try {
      spec = await this.opts.spawnSpec();
    } catch (err) {
      process.stderr.write(
        `[codeam mcp-run] token refresh failed, keeping current server (will retry): ${err instanceof Error ? err.message : String(err)}\n`,
      );
      this.swapping = false;
      for (const l of this.pendingClientLines.splice(0)) this.onClientLine(l);
      return;
    }
    const old = this.child;
    const oldRl = this.childRl;
    this.child = null;
    this.childRl = null;
    // Tear down the old child's output path BEFORE killing it: a slow-dying
    // server (uvx/python ignoring SIGTERM for a beat) can emit straggler
    // lines that must never reach the client. Belt (close the readline) and
    // braces (the per-child `child !== this.child` guard in spawnChild).
    oldRl?.close();
    old.kill('SIGTERM');
    const escalation = setTimeout(() => {
      if (!old.killed || old.exitCode === null) old.kill('SIGKILL');
    }, SIGKILL_ESCALATION_MS);
    escalation.unref();
    try {
      await this.spawnChild(stdout, spec);
      // Replay the recorded initialize under the sentinel id — positive
      // identification of the one response we must swallow.
      const replayed = JSON.parse(this.initializeLine) as Record<string, unknown>;
      this.child!.stdin!.write(JSON.stringify({ ...replayed, id: REPLAY_INIT_ID }) + '\n');
      this.child!.stdin!.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
      );
    } finally {
      this.swapping = false;
      for (const l of this.pendingClientLines.splice(0)) this.onClientLine(l);
    }
  }

  private async spawnChild(stdout: NodeJS.WritableStream, preResolved?: ProxyChildSpec): Promise<void> {
    const spec = preResolved ?? (await this.opts.spawnSpec());
    const spawn = this.opts.spawnImpl ?? nodeSpawn;
    const child = spawn(spec.command, spec.args, {
      env: { ...process.env, ...spec.env }, // env only — never argv
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.child = child;
    // A child dying with our writes still buffered on its stdin (e.g. it
    // exits mid-handshake) surfaces as an EPIPE 'error' event on the stdin
    // stream — swallow it; the 'exit' handler below owns the outcome.
    child.stdin?.on('error', () => undefined);
    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    this.childRl = rl;
    rl.on('line', (line) => {
      // Per-child guard: once this child has been swapped out (or replaced),
      // any straggling output it produces must never reach the client.
      if (child !== this.child) return;
      this.onChildLine(line, stdout);
    });
    child.on('exit', (code) => {
      // Only the CURRENT child's exit ends the proxy. A swapped-out child is
      // no longer `this.child` when it exits, so its (planned) death is
      // ignored — while a freshly-spawned child dying mid-swap IS current
      // and must fail fast rather than hang the session.
      if (child !== this.child) return;
      this.clearAllToolTimeouts();
      this.ended(code ?? 1);
    });
  }
}
