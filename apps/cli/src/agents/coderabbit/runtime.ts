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
import { getAgent, type AgentId, type AgentMetadata } from '@codeagent/shared';
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
    // CodeRabbit's `review` subcommand is the only public surface
    // the CLI plugin exposes — every invocation starts here. Caller
    // input adds more flags (`--pr`, `--file`, …) on top.
    return ['review'];
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

    const args = this.getDefaultArgs();
    if (input.prRef) args.push('--pr', input.prRef);
    if (input.files && input.files.length > 0) {
      // Pass files as positional args after the subcommand.
      args.push(...input.files);
    }
    if (input.prompt) {
      // CodeRabbit accepts a `--message` override the reviewer uses
      // as additional context.
      args.push('--message', input.prompt);
    }
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
      proc.stdout?.on('data', (b: Buffer) => stdoutBuf.push(b));
      proc.stderr?.on('data', (b: Buffer) => stderrBuf.push(b));
      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        resolve(
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
