/**
 * Shared agent-CLI install runner.
 *
 * Extracted from `HostAgentSupervisor.runAgentInstall` (host-agent.ts) so the
 * in-session agent switch (`switch_agent`) can reuse the exact same mechanics:
 * `sh -c <script>` with HOME forced, both pipes streamed to the log, a hard
 * 180 s timeout, and a promise that RESOLVES (never rejects) with the outcome.
 *
 * The install scripts come from the backend's per-agent
 * `ProvisioningStrategy.getInstallSnippet()` and are idempotent
 * (`command -v`-guarded), so re-running one is always safe.
 */
import { spawn } from 'child_process';
import * as os from 'os';
import { log } from '../../services/logger';

export interface AgentInstallResult {
  /** True iff the script exited 0 within the timeout. */
  ok: boolean;
  /** Exit code when the child exited on its own; null on timeout/spawn error. */
  code: number | null;
  timedOut: boolean;
}

/**
 * Run an agent install script. HOME is forced so the installer's
 * `~/.local/bin` resolves on a detached process whose env may lack it.
 * Never rejects — callers decide whether a failure is fatal (`switch_agent`
 * aborts the switch; the self-hosted deploy treats it as best-effort).
 */
export function runAgentInstallScript(
  script: string,
  opts: { timeoutMs?: number; logScope?: string } = {},
): Promise<AgentInstallResult> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const scope = opts.logScope ?? 'agent-install';
  return new Promise((resolve) => {
    const home = process.env.HOME || os.homedir();
    const child = spawn('sh', ['-c', script], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (b: Buffer): void => {
      const line = b.toString().replace(/\n+$/g, '');
      if (line) log.info(scope, `agent-install: ${line}`);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    let settled = false;
    const done = (result: AgentInstallResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      log.warn(scope, `agent install timed out (${Math.round(timeoutMs / 1000)}s)`);
      try {
        child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      done({ ok: false, code: null, timedOut: true });
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        log.warn(scope, `agent install exited code=${code}`);
      } else {
        log.info(scope, 'agent CLI installed');
      }
      done({ ok: code === 0, code: code ?? null, timedOut: false });
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      log.warn(scope, `agent install spawn error: ${e.message}`);
      done({ ok: false, code: null, timedOut: false });
    });
  });
}
