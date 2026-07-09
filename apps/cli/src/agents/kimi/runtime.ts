/**
 * KimiRuntimeStrategy — RuntimeStrategy for Moonshot AI's Kimi Code CLI.
 *
 * Kimi is driven EXCLUSIVELY via the ACP runtime (`kimi acp`) — see
 * `apps/cli/src/agents/acp/`. `requiresAcp('kimi')` in `start.ts` always routes
 * Kimi through ACP; the PTY-spawn path is never reached. This strategy exists
 * only so the non-spawn code paths that touch every registered agent still
 * resolve cleanly:
 *
 *   - `codeam link kimi` reaches in for `credentialLocator()` / `loginLauncher()`.
 *   - AI Insights / Summary + Preview detection call `generateOneShot()`.
 *   - The agent-contract suite iterates every runtime builder and asserts shape.
 *
 * Baton (Take Control) IS supported — mirroring Cursor. Kimi stores a per-session
 * append-only transcript at
 * `<KIMI_CODE_HOME>/sessions/wd_<key>/<sessionId>/agents/main/wire.jsonl`, its
 * `kimi acp` server advertises `loadSession:true` (session/load resume), and the
 * native TUI resumes by id with `kimi -S <id>` — all verified live on a real box.
 * `resolveHistoryFile` (below) is the capability marker `runtimeSupportsBaton`
 * checks. Everything Kimi-specific lives in this strategy + `./history.ts`; no
 * shared baton code is touched.
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
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as history from './history';
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

// Kimi K2 "for coding" ships a 256K context window (the docs set Claude Code's
// auto-compact window to 262144 when routing through Kimi). One entry is enough
// for the mobile picker — the subscription is tied to `kimi-for-coding`.
const KIMI_CONTEXT_WINDOW = 262_144;
const KIMI_MODELS: AgentModel[] = [
  { id: 'kimi-for-coding', label: 'Kimi for Coding', contextWindow: KIMI_CONTEXT_WINDOW },
];

/** OAuth login-state dir the `kimi` toolchain writes (phase-2 capture target). */
function kimiCredentialsDir(): string {
  const root = process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');
  return join(root, 'credentials');
}

export class KimiRuntimeStrategy implements RuntimeStrategy {
  readonly id: AgentId = 'kimi';
  readonly meta: AgentMetadata = getAgent('kimi');
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
    const binary = this.os.findInPath('kimi');
    if (!binary) {
      // OS-aware install guidance — Kimi Code CLI has no Windows-native build, so
      // on Windows the only path is WSL (matches `ensureKimiInstalled` in
      // ./installer.ts). Elsewhere it's the official curl|bash script.
      const install =
        this.os.id === 'win32'
          ? 'Kimi Code CLI on Windows requires WSL. Install it inside WSL with:\n' +
            '    curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash\n' +
            '    then re-run `codeam pair` from WSL.'
          : 'Kimi Code CLI is not on PATH. Install it with:\n' +
            '    curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash\n' +
            '    Then run `codeam pair` again.';
      throw new Error(install);
    }
    // Production never spawns Kimi over a PTY (ACP path); this satisfies the
    // contract so `createInteractiveAgentStrategy` resolves cleanly.
    const launch = this.os.buildLaunch(binary, []);
    return { cmd: launch.cmd, args: launch.args };
  }

  /** Re-attach the same conversation on baton hand-back — kimi resumes a session
   *  by id with `kimi -S <id>` (`-S, --session [id]`). */
  resumeLaunchArgs(sessionId: string, _opts?: { auto?: boolean }): string[] {
    return ['-S', sessionId];
  }

  resolveHistoryDir(cwd: string): string | null {
    return history.resolveHistoryDir(cwd);
  }

  /**
   * `<KIMI_CODE_HOME>/sessions/wd_<key>/<sessionId>/agents/main/wire.jsonl`.
   * Implementing this is what lets the baton engage for Kimi
   * (`runtimeSupportsBaton`), so LOCAL_DRIVE can tail the transcript and Take
   * Control resumes the SAME conversation over ACP `session/load` — verified
   * live: `kimi acp` advertises `loadSession:true`.
   */
  resolveHistoryFile(cwd: string, sessionId: string): string | null {
    return history.resolveHistoryFile(cwd, sessionId);
  }

  parseHistoryFile(filePath: string): NormalizedMessage[] {
    return history.parseHistoryFile(filePath);
  }

  /**
   * Kimi neither accepts a pre-set session id (`kimi -S <newid>` fails
   * "Session not found") NOR prints its id on stdout — it MINTS one itself and
   * writes it to `<KIMI_CODE_HOME>/sessions/wd_<key>/<sessionId>/` when the
   * native TUI boots. So `prepareLaunch` can't return a `sessionId` and the
   * baton's NativeTuiDriver has nothing to bind. This hook bounded-polls that
   * store for the dir kimi just created (mtime ≥ spawn time) and returns its id.
   * Kimi-specific — no other agent implements this (claude pre-mints; the rest
   * have no baton), so the driver's optional call is inert for them.
   */
  discoverSessionId(
    cwd: string,
    opts: { sinceMs: number; timeoutMs?: number },
  ): Promise<string | null> {
    return history.discoverSessionId(cwd, opts);
  }

  getCurrentUsage(
    historyDir: string,
  ): { used: number; total: number; percent: number; model?: string } | null {
    return history.getCurrentUsage(historyDir);
  }

  async fetchWeeklyUsage(): Promise<{ percent: number; resetAt?: string } | null> {
    return null;
  }

  async listModels(): Promise<AgentModel[]> {
    return KIMI_MODELS;
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
   * claude/codex/gemini. Kimi's non-interactive print mode is
   * `kimi -p "<prompt>" --output-format text`: it streams the assistant reply
   * to stdout under the `auto` permission policy (no approval prompt) and exits.
   * Returns `null` on spawn failure / timeout / empty output so callers skip
   * silently instead of bubbling a partial reply.
   */
  async generateOneShot(
    prompt: string,
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<string | null> {
    const binary = this.os.findInPath('kimi');
    if (!binary) return null;
    const launch = this.os.buildLaunch(binary, ['-p', prompt, '--output-format', 'text']);
    return spawnAndCapture(launch.cmd, launch.args, {
      cwd: opts?.cwd,
      timeoutMs: opts?.timeoutMs,
    });
  }

  credentialLocator(): AgentCredentialLocator {
    return {
      publicId: 'kimi',
      vendor: 'Moonshot',
      hint: '~/.kimi-code/credentials/',
      watchPaths: () => [kimiCredentialsDir()],
      // Phase-2 OAuth capture: the `kimi` toolchain writes per-provider OAuth
      // JSON under this dir after `/login`. Until that flow is reverse-engineered
      // (blob format + refresh), file capture is a no-op — the shipping auth is
      // the API key (KIMI_API_KEY), delivered by the provisioner, not this
      // watcher. Returning null means "nothing captured here yet".
      extract: async () => null,
      validate: validateNonEmptyCredential,
    };
  }

  loginLauncher(): AgentLoginLauncher {
    return {
      async ensureInstalled(): Promise<boolean> {
        // No bundled installer — Kimi CLI installs via the curl script. Refuse
        // to install without consent; surface presence and let the user re-run.
        return createOsStrategy().findInPath('kimi') !== null;
      },
      launch(): ChildProcess {
        // Kimi's login is the in-REPL `/login` slash command; launching `kimi`
        // with inherited stdio lets the user run it and complete OAuth.
        return spawn('kimi', [], { stdio: 'inherit' });
      },
    };
  }
}
