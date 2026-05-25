import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { getAgent, type AgentId, type AgentMetadata, type AgentModel, type ChromeStep, type SelectPrompt } from '@codeagent/shared';
import type { OsStrategy } from '../../os';
import * as history from './history';
import { filterCodexChrome, parseCodexChrome, detectCodexSelector } from './parsing';
import { renderCodexBuffer } from './renderer';
import { codexCredentialLocator, codexLoginLauncher } from './link';
import { spawnAndCapture } from '../../services/spawn-and-capture';
import type { ChangeModelInstruction, RuntimeStrategy } from '../strategy';

const CODEX_CONTEXT_WINDOW = 272_000;

const CODEX_MODELS: AgentModel[] = [
  { id: 'gpt-5.5',           label: 'GPT-5.5',           contextWindow: CODEX_CONTEXT_WINDOW },
  { id: 'gpt-5.4',           label: 'GPT-5.4',           contextWindow: CODEX_CONTEXT_WINDOW },
  { id: 'gpt-5.4-mini',      label: 'GPT-5.4 Mini',      contextWindow: CODEX_CONTEXT_WINDOW },
  { id: 'gpt-5.3-codex',     label: 'GPT-5.3 Codex',     contextWindow: CODEX_CONTEXT_WINDOW },
  { id: 'gpt-5.2',           label: 'GPT-5.2',           contextWindow: CODEX_CONTEXT_WINDOW },
  { id: 'codex-auto-review', label: 'Codex Auto Review', contextWindow: CODEX_CONTEXT_WINDOW },
];

export class CodexRuntimeStrategy implements RuntimeStrategy {
  readonly id: AgentId = 'codex';
  readonly meta: AgentMetadata = getAgent('codex');
  readonly mode = 'interactive' as const;
  readonly os: OsStrategy;

  constructor(os: OsStrategy) {
    this.os = os;
  }

  async prepareLaunch(): Promise<{ cmd: string; args: string[]; env?: Record<string, string> }> {
    let binary = this.os.findInPath('codex');
    if (binary) return this.os.buildLaunch(binary);

    // Codex isn't on PATH — run the official installer inline so pairing
    // → first prompt is a single uninterrupted flow on a clean machine.
    // stdio: 'inherit' surfaces npm's progress directly to the user's
    // terminal, so a long download or a permission failure is visible
    // (not silently swallowed).
    console.log('\n  Codex CLI not found — installing via `npm install -g @openai/codex`...\n');
    try {
      await installCodexViaNpm(this.os);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to install Codex CLI automatically (${msg}).\n` +
          '    Install it manually with:\n' +
          '      npm install -g @openai/codex\n' +
          '    Then run `codeam pair` again.',
      );
    }

    // npm drops the binary into its global bin dir, which may not be on
    // this process's PATH (typical for nvm / fnm installs that only set
    // PATH in shell-rc files). Prepend the resolved dir so the
    // post-install probe sees the binary without a shell restart.
    augmentNpmGlobalBin(this.os);

    binary = this.os.findInPath('codex');
    if (!binary) {
      throw new Error(
        'Codex CLI was installed but the binary is not visible on PATH for this process.\n' +
          '    Restart your terminal and run `codeam pair` again.',
      );
    }
    return this.os.buildLaunch(binary);
  }

  /** `codex resume <SESSION_ID>` — subcommand, not flag. Codex has
   * no permissions-bypass equivalent, so the `opts.auto` flag is
   * silently ignored (the same args work for both user-initiated
   * and background relaunches). */
  resumeLaunchArgs(sessionId: string, _opts?: { auto?: boolean }): string[] {
    return ['resume', sessionId];
  }

  resolveHistoryDir(cwd: string): string | null {
    return history.resolveHistoryDir(cwd);
  }

  parseHistoryFile(filePath: string) {
    return history.parseHistoryFile(filePath);
  }

  getCurrentUsage(historyDir: string) {
    return history.getCurrentUsage(historyDir);
  }

  /**
   * Codex's quota lives behind the `account/get_account_rate_limits` RPC,
   * not a TUI slash command. Phase 2 ships with this stubbed to null so the
   * mobile shows "—" for weekly usage on Codex sessions. A follow-up will
   * invoke the RPC directly.
   */
  async fetchWeeklyUsage(): Promise<{ percent: number; resetAt?: string } | null> {
    return null;
  }

  async listModels(): Promise<AgentModel[]> {
    return CODEX_MODELS;
  }

  changeModelInstruction(modelId: string): ChangeModelInstruction {
    return { type: 'pty', ptyInput: `/model ${modelId}\r` };
  }

  /**
   * Codex has no auto-compact (`auto_compact_token_limit: null` for every
   * model). Both modes fall through to the manual `/compact` slash command.
   */
  summarizeInstruction(_mode: 'normal' | 'auto'): { ptyInput: string } {
    return { ptyInput: '/compact\r' };
  }

  // ─── TUI parser strategy methods ─────────────────────────────────

  /**
   * Codex needs its own virtual terminal because the Codex CLI uses
   * DECSTBM scroll regions (`\x1B[1;31r`) and Reverse Index (`\x1BM`)
   * to scroll chat history within a fixed top zone — bytes the shared
   * renderer drops, leaving the mobile feed with only the most recent
   * frame instead of the full reply. See ./renderer.ts.
   */
  renderToLines(buffer: string): string[] {
    return renderCodexBuffer(buffer);
  }

  parseTuiChrome(line: string): ChromeStep | null {
    return parseCodexChrome(line);
  }

  filterTuiOutput(lines: string[]): string[] {
    return filterCodexChrome(lines);
  }

  detectInteractivePrompt(lines: string[]): SelectPrompt | null {
    return detectCodexSelector(lines);
  }

  detectReadyPrompt(lines: string[]): boolean {
    // Codex's ratatui input box reappears at the bottom of the
    // screen the moment the agent stops working — `│ › │` (box
    // border + U+203A SINGLE RIGHT-POINTING ANGLE QUOTATION MARK
    // cursor). The cursor char survives across versions; box
    // borders may swap (╭╮╰╯ / ┌┐└┘) so we anchor only on the
    // U+203A + adjacent box-bar.
    return lines.some((l) => /[│┃]\s*›/u.test(l));
  }

  credentialLocator() {
    return codexCredentialLocator();
  }

  loginLauncher() {
    return codexLoginLauncher();
  }

  async generateOneShot(
    prompt: string,
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<string | null> {
    // `codex exec "<prompt>"` runs Codex CLI in non-interactive mode —
    // prints the response to stdout and exits. Separate child process
    // from the user's active session so it can't interfere with their
    // current turn.
    const binary = this.os.findInPath('codex');
    if (!binary) return null;
    const launch = this.os.buildLaunch(binary, ['exec', prompt]);
    return spawnAndCapture(launch.cmd, launch.args, {
      cwd: opts?.cwd,
      timeoutMs: opts?.timeoutMs,
    });
  }
}

/**
 * Resolve the `npm` binary path for the current OS. On Windows the
 * shim is `npm.cmd`; on POSIX it's `npm` on PATH. We probe via the
 * OsStrategy so any future "npm via nvm under shell-rc only" case
 * is encapsulated in one place.
 */
function resolveNpm(os: OsStrategy): string {
  return os.id === 'win32' ? 'npm.cmd' : 'npm';
}

async function installCodexViaNpm(os: OsStrategy): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveNpm(os), ['install', '-g', '@openai/codex'], {
      stdio: 'inherit',
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install -g @openai/codex exited ${code}`));
    });
    proc.on('error', (err) => {
      // ENOENT = `npm` itself is not on PATH (no Node.js install). Give
      // a hint instead of leaking the cryptic spawn error verbatim.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        reject(new Error('`npm` is not on PATH. Install Node.js first, then retry.'));
      } else {
        reject(err);
      }
    });
  });
}

function augmentNpmGlobalBin(os: OsStrategy): void {
  try {
    const result = spawnSync(resolveNpm(os), ['prefix', '-g'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) return;
    const prefix = result.stdout.toString().trim();
    if (!prefix) return;
    // Unix: <prefix>/bin · Windows: <prefix> (npm drops the .cmd shim
    // directly into the prefix dir, not a `bin/` subdir).
    const binDir = os.id === 'win32' ? prefix : path.join(prefix, 'bin');
    os.augmentPath([binDir]);
  } catch {
    /* best effort — the post-install findInPath will still try the
       unmodified PATH and surface a clear error if codex is missing. */
  }
}
