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
  private swapping = false;
  private pendingClientLines: string[] = [];
  private ended: (code: number) => void = () => undefined;

  constructor(private readonly opts: Opts) {}

  async start(): Promise<void> {
    const stdin = this.opts.stdin ?? process.stdin;
    const stdout = this.opts.stdout ?? process.stdout;
    await this.spawnChild(stdout);

    const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });
    rl.on('line', (line) => this.onClientLine(line));
    rl.on('close', () => this.child?.stdin?.end());

    const timer = setInterval(() => void this.maybeRestart(stdout), RESTART_CHECK_INTERVAL_MS);
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
      const msg = JSON.parse(line) as { method?: string; id?: string | number };
      if (msg.method === 'initialize' && this.initializeLine === null) {
        this.initializeLine = line;
      }
      if (msg.id !== undefined && msg.method !== undefined) this.inflight.add(msg.id);
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
      }
    } catch {
      /* forward verbatim */
    }
    stdout.write(line + '\n');
    if (this.inflight.size === 0) void this.maybeRestart(stdout);
  }

  private async maybeRestart(stdout: NodeJS.WritableStream): Promise<void> {
    if (this.swapping || !this.opts.shouldRestartNow()) return;
    if (this.inflight.size > 0 || this.initializeLine === null || !this.child) return;
    this.swapping = true;
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
      await this.spawnChild(stdout);
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

  private async spawnChild(stdout: NodeJS.WritableStream): Promise<void> {
    const spec = await this.opts.spawnSpec();
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
      this.ended(code ?? 1);
    });
  }
}
