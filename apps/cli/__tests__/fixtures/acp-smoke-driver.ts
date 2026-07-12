/**
 * Shared ACP smoke driver — the reusable handshake used by every
 * ACP-provision integration test.
 *
 * It spawns an agent's ACP server (`<binary> acp` / the adapter bin),
 * drives the minimal JSON-RPC handshake over stdio — `initialize` →
 * `session/new` → `session/prompt` — and classifies the OUTCOME so a
 * table-driven suite can assert the auth BEHAVIOUR that unit tests (which
 * only check "the credential file was written") cannot:
 *
 *   - `streamed`     — the turn produced real assistant text
 *                      (`agent_message_chunk`) → provisioned + authed + answering.
 *   - `empty`        — the turn RESOLVED but streamed zero assistant text.
 *                      This is the "provisioned but no model configured / empty
 *                      response" class (the kimi 0.23.5 config regression).
 *   - `auth_error`   — `session/new` or `session/prompt` returned `-32000`
 *                      "Authentication required" (the class Step 8 guards).
 *   - `rpc_error`    — a non-auth JSON-RPC error at new/prompt.
 *   - `spawn_error`  — the agent binary could not be spawned (ENOENT/EACCES).
 *   - `timeout`      — no terminal signal within the deadline.
 *
 * This is a SUPPORT module (no `describe`/`it`) and deliberately lives under
 * `__tests__/fixtures/` so vitest's test glob doesn't collect it as an empty
 * suite (see `vitest.config.ts` `exclude`). Imported by
 * `__tests__/integration/acp-provision-smoke.int.test.ts` and
 * `__tests__/integration/kimi-acp-provision.int.test.ts`.
 */

import { spawn } from 'node:child_process';

/** Fully-resolved spawn recipe for one agent's ACP server. */
export interface AcpSpawnSpec {
  /** Executable — an agent binary (`kimi`, `gemini`, `cursor-agent`) or
   *  `process.execPath` when the adapter is a node bin. */
  command: string;
  /** Args appended verbatim (`['acp']`, `['--skip-trust','--acp']`, `[bin.js]`). */
  args: string[];
  /** FULL child environment (the caller composes process.env minus stray
   *  agent creds, plus the provisioned cred env + agent-specific vars). */
  env: NodeJS.ProcessEnv;
  /** Working directory → the agent's primary session root. */
  cwd: string;
}

export type AcpOutcome =
  | { kind: 'streamed'; stopReason?: string }
  | { kind: 'empty'; stopReason?: string }
  | { kind: 'auth_error'; code: number; message: string }
  | { kind: 'rpc_error'; code: number; message: string }
  | { kind: 'spawn_error'; message: string }
  | { kind: 'timeout' };

export interface AcpSmokeReport {
  /** Terminal classification of the handshake. */
  outcome: AcpOutcome;
  /** `authMethods[].id` advertised at `initialize` (informational — some
   *  agents, e.g. kimi, advertise `login` STATICALLY even when authed, so
   *  the real auth signal is the session/prompt outcome, not this). */
  initializeAuthMethods: string[];
  /** Concatenated `agent_message_chunk` text seen during the turn. */
  streamedText: string;
  /** True once `session/new` resolved with a sessionId (no -32000). */
  sessionCreated: boolean;
  /** Small ring of notable frames for debugging / the run report. */
  frames: string[];
}

export interface AcpSmokeOptions {
  /** Prompt text sent as the single turn. Default: "reply with just OK". */
  promptText?: string;
  /** Overall idle/total deadline in ms. Default: 45_000. */
  timeoutMs?: number;
}

/** True for the JSON-RPC error shapes that mean "not authenticated". */
function isAuthError(code: number, message: string): boolean {
  // -32000 is the code kimi/claude-agent-acp use for "Authentication required".
  return code === -32000 || /authentication required|not logged in|unauthorized|\b401\b/i.test(message);
}

/**
 * Spawn `spec`, drive `initialize → session/new → session/prompt`, and
 * resolve an {@link AcpSmokeReport}. Never rejects — every failure mode is a
 * classified `outcome`. The child is always killed before resolving.
 */
export function acpSmokeDrive(spec: AcpSpawnSpec, opts: AcpSmokeOptions = {}): Promise<AcpSmokeReport> {
  const promptText = opts.promptText ?? 'reply with just OK';
  const timeoutMs = opts.timeoutMs ?? 45_000;

  return new Promise((resolve) => {
    const report: AcpSmokeReport = {
      outcome: { kind: 'timeout' },
      initializeAuthMethods: [],
      streamedText: '',
      sessionCreated: false,
      frames: [],
    };
    let settled = false;

    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const done = (outcome: AcpOutcome): void => {
      if (settled) return;
      settled = true;
      report.outcome = outcome;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* noop */
      }
      resolve(report);
    };

    const send = (o: unknown): void => {
      try {
        child.stdin.write(`${JSON.stringify(o)}\n`);
      } catch {
        /* child already gone — the exit/error handler resolves */
      }
    };

    const pushFrame = (s: string): void => {
      report.frames.push(s);
      if (report.frames.length > 24) report.frames.shift();
    };

    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m: {
          id?: number;
          method?: string;
          result?: {
            sessionId?: string;
            stopReason?: string;
            authMethods?: Array<{ id?: string }>;
          };
          error?: { code: number; message: string };
          params?: { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } };
        };
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }

        // initialize → capture advertised auth methods, then open a session.
        if (m.id === 1 && m.result) {
          report.initializeAuthMethods = (m.result.authMethods ?? [])
            .map((a) => a.id)
            .filter((x): x is string => typeof x === 'string');
          pushFrame(`initialize ← authMethods=[${report.initializeAuthMethods.join(',')}]`);
          send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: spec.cwd, mcpServers: [] } });
        }

        // session/new resolved → send the trivial prompt.
        if (m.id === 2 && m.result?.sessionId) {
          report.sessionCreated = true;
          pushFrame(`session/new ← ok sessionId=${m.result.sessionId.slice(0, 8)}`);
          send({
            jsonrpc: '2.0',
            id: 3,
            method: 'session/prompt',
            params: { sessionId: m.result.sessionId, prompt: [{ type: 'text', text: promptText }] },
          });
        }

        // Assistant text streaming.
        if (m.method === 'session/update' && m.params?.update?.sessionUpdate === 'agent_message_chunk') {
          const t = m.params.update.content?.text;
          if (typeof t === 'string' && t.length > 0) {
            report.streamedText += t;
            if (report.frames[report.frames.length - 1]?.startsWith('agent_message_chunk') !== true) {
              pushFrame('agent_message_chunk (streaming…)');
            }
          }
        }

        // Error at session/new or session/prompt → auth vs generic rpc error.
        if ((m.id === 2 || m.id === 3) && m.error) {
          pushFrame(`error id=${m.id} code=${m.error.code} ${m.error.message.slice(0, 80)}`);
          done(
            isAuthError(m.error.code, m.error.message)
              ? { kind: 'auth_error', code: m.error.code, message: m.error.message }
              : { kind: 'rpc_error', code: m.error.code, message: m.error.message },
          );
        }

        // Turn resolved → streamed (has text) vs empty (no assistant text).
        if (m.id === 3 && m.result) {
          const stopReason = m.result.stopReason;
          pushFrame(`session/prompt ← stopReason=${stopReason ?? '?'} textLen=${report.streamedText.length}`);
          done(
            report.streamedText.length > 0
              ? { kind: 'streamed', stopReason }
              : { kind: 'empty', stopReason },
          );
        }
      }
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      pushFrame(`spawn error ${err.code ?? err.message}`);
      done({ kind: 'spawn_error', message: `${err.code ?? ''} ${err.message}`.trim() });
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      // The adapter died before any terminal signal — classify by what we saw.
      pushFrame(`adapter exited code=${code} signal=${signal}`);
      if (report.streamedText.length > 0) {
        done({ kind: 'streamed' });
      } else {
        done({ kind: 'timeout' });
      }
    });

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });

    const timer = setTimeout(() => {
      done(report.streamedText.length > 0 ? { kind: 'streamed' } : { kind: 'timeout' });
    }, timeoutMs);
  });
}
