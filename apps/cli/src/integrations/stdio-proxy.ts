// src/integrations/stdio-proxy.ts
//
// A restartable, line-delimited JSON-RPC pass-through between the parent's
// stdin/stdout and a spawned child MCP server. Used by `codeam mcp-run <id>`
// to keep an integration's short-lived broker token fresh without the
// agent's MCP client ever seeing a hiccup: when the token is near expiry AND
// there is no in-flight request, the child is killed, respawned with a
// freshly-fetched token (via `spawnSpec()`), and the ORIGINAL `initialize`
// request is replayed to it (so the new child's session state matches what
// the agent already negotiated) — its response is swallowed (the agent
// already has one) and a `notifications/initialized` is sent to complete the
// handshake. Client lines that arrive mid-swap are buffered and flushed once
// the new child is ready, so nothing is lost or reordered.
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

export class RestartableStdioProxy {
  private child: ChildProcess | null = null;
  private initializeLine: string | null = null;
  private initializeId: string | number | null = null;
  private inflight = new Set<string | number>();
  private swapping = false;
  private pendingClientLines: string[] = [];
  private swallowNextInitializeResponse = false;
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
        this.initializeId = msg.id ?? null;
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
        if (this.swallowNextInitializeResponse && msg.id === this.initializeId) {
          this.swallowNextInitializeResponse = false;
          return; // replayed-initialize response: the client already has one
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
    this.child = null;
    old.removeAllListeners('exit');
    old.kill('SIGTERM');
    try {
      await this.spawnChild(stdout);
      this.swallowNextInitializeResponse = true;
      this.child!.stdin!.write(this.initializeLine + '\n');
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
    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => this.onChildLine(line, stdout));
    child.on('exit', (code) => {
      if (!this.swapping) this.ended(code ?? 1);
    });
  }
}
