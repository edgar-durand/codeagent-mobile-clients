/**
 * OpencodeRuntimeStrategy — RuntimeStrategy for opencode (https://opencode.ai).
 *
 * opencode is driven EXCLUSIVELY via the ACP runtime (`opencode acp`) — see
 * `apps/cli/src/agents/acp/`. `requiresAcp('opencode')` in `start.ts` always
 * routes it through ACP; the PTY-spawn path is never reached. This strategy
 * exists only so the non-spawn code paths that touch every registered agent
 * still resolve cleanly:
 *
 *   - `codeam link opencode` reaches in for `credentialLocator()` /
 *     `loginLauncher()` (capture ~/.local/share/opencode/auth.json).
 *   - AI Insights / Summary + Preview detection call `generateOneShot()`.
 *   - The agent-contract suite iterates every runtime builder and asserts shape.
 *
 * Baton (Take Control) is NOT wired for opencode v1 (`resolveHistoryFile`
 * omitted → `runtimeSupportsBaton` is false), so LOCAL_DRIVE is unavailable —
 * a follow-up once opencode's transcript layout + `session/load` are verified.
 */

import {
  getAgent,
  type AgentId,
  type AgentMetadata,
  type AgentModel,
  type NormalizedMessage,
  type SelectPrompt,
} from '@codeam/shared';
import { spawn, type ChildProcess } from 'node:child_process';
import { spawnAndCapture } from '../../services/spawn-and-capture';
import { createOsStrategy } from '../../os';
import type { OsStrategy } from '../../os';
import {
  validateNonEmptyCredential,
  type AgentCredentialLocator,
  type AgentLoginLauncher,
  type ChangeModelInstruction,
  type RuntimeStrategy,
} from '../strategy';
import { extractLocalOpencodeToken, opencodeCredentialsPaths } from './local-token';

export class OpencodeRuntimeStrategy implements RuntimeStrategy {
  readonly id: AgentId = 'opencode';
  readonly meta: AgentMetadata = getAgent('opencode');
  readonly mode = 'interactive' as const;
  readonly os: OsStrategy;

  constructor(os: OsStrategy) {
    this.os = os;
  }

  async prepareLaunch(): Promise<{
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    sessionId?: string;
  }> {
    const binary = this.os.findInPath('opencode');
    if (!binary) {
      throw new Error(
        'opencode is not on PATH. Install it with:\n' +
          '    curl -fsSL https://opencode.ai/install | bash\n' +
          '    Then run `codeam pair` again.',
      );
    }
    // Production never spawns opencode over a PTY (ACP path); this satisfies the
    // contract so `createInteractiveAgentStrategy` resolves cleanly.
    const launch = this.os.buildLaunch(binary, []);
    return { cmd: launch.cmd, args: launch.args };
  }

  resumeLaunchArgs(_sessionId: string, _opts?: { auto?: boolean }): string[] {
    // Baton not wired for opencode v1 — never called.
    return [];
  }

  resolveHistoryDir(_cwd: string): string | null {
    return null;
  }

  parseHistoryFile(_filePath: string): NormalizedMessage[] {
    return [];
  }

  getCurrentUsage(
    _historyDir: string,
  ): { used: number; total: number; percent: number; model?: string } | null {
    return null;
  }

  async fetchWeeklyUsage(): Promise<{ percent: number; resetAt?: string } | null> {
    return null;
  }

  async listModels(): Promise<AgentModel[]> {
    // opencode is multi-provider — the actual model is chosen inside opencode's
    // own config (Models.dev + `opencode auth login`), not a CodeAgent picker.
    // A single sentinel entry represents "whatever you configured" so the
    // runtime contract (≥1 model) holds without implying we control the routing.
    return [{ id: 'default', label: 'Provider default', contextWindow: 200_000 }];
  }

  changeModelInstruction(modelId: string): ChangeModelInstruction {
    return { type: 'pty', ptyInput: `/model ${modelId}\r` };
  }

  summarizeInstruction(_mode: 'normal' | 'auto'): { ptyInput: string } {
    return { ptyInput: '/compact\r' };
  }

  filterTuiOutput(lines: string[]): string[] {
    return lines;
  }

  detectInteractivePrompt(_lines: string[]): SelectPrompt | null {
    return null;
  }

  /**
   * Headless single-prompt invocation — powers `request_ai_summary` /
   * `request_ai_insight` (Files review) AND Preview detection, same as
   * claude/codex/gemini/kimi. opencode's non-interactive mode is
   * `opencode run "<prompt>"`: it runs the prompt to completion and prints the
   * assistant reply to stdout (auth from ~/.local/share/opencode/auth.json).
   * Returns `null` on spawn failure / timeout / empty output so callers skip
   * silently instead of bubbling a partial reply.
   */
  async generateOneShot(
    prompt: string,
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<string | null> {
    const binary = this.os.findInPath('opencode');
    if (!binary) return null;
    const launch = this.os.buildLaunch(binary, ['run', prompt]);
    return spawnAndCapture(launch.cmd, launch.args, {
      cwd: opts?.cwd,
      timeoutMs: opts?.timeoutMs,
    });
  }

  credentialLocator(): AgentCredentialLocator {
    return {
      publicId: 'opencode',
      vendor: 'opencode',
      hint: 'ANTHROPIC_API_KEY / OPENAI_API_KEY / … env var (opencode auto-detects)',
      watchPaths: opencodeCredentialsPaths,
      extract: extractLocalOpencodeToken,
      validate: validateNonEmptyCredential,
    };
  }

  loginLauncher(): AgentLoginLauncher {
    return {
      async ensureInstalled(): Promise<boolean> {
        return createOsStrategy().findInPath('opencode') !== null;
      },
      launch(): ChildProcess {
        // opencode auto-detects provider keys from env vars (like aider) — no
        // interactive login needed. `opencode auth login` also works for users
        // who prefer the provider picker; inherited stdio lets them complete it.
        return spawn('opencode', ['auth', 'login'], { stdio: 'inherit' });
      },
    };
  }
}
