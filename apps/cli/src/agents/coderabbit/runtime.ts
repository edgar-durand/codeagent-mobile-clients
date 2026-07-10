/**
 * CodeRabbit BatchAgentStrategy.
 *
 * CodeRabbit is a one-shot reviewer (`coderabbit review --pr=N`,
 * `coderabbit review path/to/file`) — no PTY, no TUI, no streaming.
 * The runtime spawns the CLI, waits for exit, parses the stdout
 * into a structured `BatchInvocationOutput`, returns to the caller.
 *
 * Mode-specific deviations from InteractiveAgentStrategy:
 *   - No `prepareLaunch / resumeLaunchArgs` (no long-lived process).
 *   - No `filterTuiOutput / detectInteractivePrompt` (no TUI).
 *   - No `listModels / changeModelInstruction` (CodeRabbit picks
 *     its model server-side; the CLI doesn't expose a slot).
 *   - `runOneShot` is the entry point the CLI command layer uses
 *     when a user runs `codeam coderabbit --pr=123`.
 */

import { spawn } from 'node:child_process';
import { getAgent, type AgentId, type AgentMetadata } from '@codeam/shared';

// Hard ceiling for a single CodeRabbit one-shot (review / detect). CodeRabbit's
// `review --plain` opens a WebSocket to `ide.coderabbit.ai`; when that hangs the
// process never exits and `runOneShot`'s promise would never resolve — wedging
// the command handler that awaits it and, with it, the whole relay's poll +
// heartbeat loop (the 2026-07-10 "LAST PING —" / stuck-session incident: a review
// hung on `wss://ide.coderabbit.ai/ws` at 15:07:29 and the codespace never
// recovered). 5 min is comfortably longer than a real review of local changes
// yet bounded so a hung socket can't strand the session forever.
const CODERABBIT_ONESHOT_TIMEOUT_MS = 5 * 60_000;
import { ensureCoderabbitInstalled } from './installer';
import { coderabbitCredentialLocator, coderabbitLoginLauncher } from './link';
import { parseReview } from './parsing';
import type { OsStrategy } from '../../os';
import type {
  BatchAgentStrategy,
  BatchInvocationInput,
  BatchInvocationOutput,
} from '../strategy';

export class CoderabbitRuntimeStrategy implements BatchAgentStrategy {
  readonly id: AgentId = 'coderabbit';
  readonly meta: AgentMetadata = getAgent('coderabbit');
  readonly mode = 'batch' as const;
  readonly os: OsStrategy;

  constructor(os: OsStrategy) {
    this.os = os;
  }

  getDefaultArgs(): string[] {
    // `coderabbit review` is the only review surface. Structured
    // `--agent` output is the default we want everywhere (mobile +
    // cross-review consume the machine-readable findings). Real CLI
    // flags only — verified against `coderabbit review --help` (0.6.x):
    // there is NO `--pr` and NO `--message`; reviews are LOCAL git
    // changes selected by `-t/--base/--dir`.
    return ['review', '--agent'];
  }

  async prepareInvocation(input: BatchInvocationInput): Promise<{
    cmd: string;
    args: string[];
    env?: Record<string, string>;
  }> {
    // Resolve the binary up-front — `runOneShot` will spawn this
    // directly. If the binary is missing the launcher's
    // `ensureInstalled` should have already been called by the
    // caller; if it wasn't, surface a clear error.
    const binary = this.os.findInPath(this.meta.binaryName);
    if (!binary) {
      throw new Error(
        `CodeRabbit binary "${this.meta.binaryName}" not on PATH. ` +
          'Run `codeam link coderabbit` to install it first.',
      );
    }

    // Base: `review` + structured/plain mode.
    const args = input.structured === false ? ['review', '--plain'] : this.getDefaultArgs();
    // Change-set selection.
    if (input.changeSet) args.push('--type', input.changeSet);
    if (input.base) args.push('--base', input.base);
    if (input.baseCommit) args.push('--base-commit', input.baseCommit);
    if (input.dir) args.push('--dir', input.dir);
    // Per-invocation auth (when not logged in via the credential store).
    // Passed via argv is unavoidable with this CLI; callers keep the key
    // out of logs. Prefer the login-state file when available.
    if (input.apiKey) args.push('--api-key', input.apiKey);
    if (input.extraArgs && input.extraArgs.length > 0) {
      args.push(...input.extraArgs);
    }

    return this.os.buildLaunch(binary, args);
  }

  parseOutput(args: {
    exitCode: number;
    stdout: string;
    stderr: string;
  }): BatchInvocationOutput {
    const parsed = parseReview(args.stdout);
    return {
      exitCode: args.exitCode,
      markdown: parsed.markdown,
      hunks: parsed.hunks,
      stats: parsed.stats,
      rawStdout: args.stdout,
      rawStderr: args.stderr,
    };
  }

  async runOneShot(input: BatchInvocationInput): Promise<BatchInvocationOutput> {
    const launch = await this.prepareInvocation(input);
    return new Promise<BatchInvocationOutput>((resolve, reject) => {
      const stdoutBuf: Buffer[] = [];
      const stderrBuf: Buffer[] = [];
      const proc = spawn(launch.cmd, launch.args, {
        env: { ...process.env, ...(launch.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Guard the whole invocation with a hard timeout so a hung CodeRabbit
      // WebSocket can't keep this promise (and the awaiting command handler)
      // pending forever. On expiry: kill the process (SIGTERM → SIGKILL) and
      // resolve with whatever partial output we captured + a non-zero exit so
      // the caller surfaces a clean "review timed out" instead of hanging.
      let settled = false;
      const finish = (out: BatchInvocationOutput) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(out);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        try {
          proc.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        // Escalate if SIGTERM didn't land it.
        setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, 2_000).unref?.();
        finish(
          this.parseOutput({
            exitCode: 124,
            stdout: Buffer.concat(stdoutBuf).toString('utf8'),
            stderr:
              Buffer.concat(stderrBuf).toString('utf8') +
              `\nCodeRabbit review timed out after ${Math.round(
                CODERABBIT_ONESHOT_TIMEOUT_MS / 60_000,
              )} min and was terminated.`,
          }),
        );
      }, CODERABBIT_ONESHOT_TIMEOUT_MS);
      timer.unref?.();

      proc.stdout?.on('data', (b: Buffer) => stdoutBuf.push(b));
      proc.stderr?.on('data', (b: Buffer) => stderrBuf.push(b));
      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (code) => {
        finish(
          this.parseOutput({
            exitCode: code ?? 0,
            stdout: Buffer.concat(stdoutBuf).toString('utf8'),
            stderr: Buffer.concat(stderrBuf).toString('utf8'),
          }),
        );
      });
    });
  }

  credentialLocator() {
    return coderabbitCredentialLocator();
  }

  loginLauncher() {
    return coderabbitLoginLauncher(this.os);
  }
}

// Re-export for the registry factory.
export { ensureCoderabbitInstalled };
