import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { getAgent, type AgentId, type AgentMetadata, type AgentModel, type ChromeStep, type SelectPrompt } from '@codeagent/shared';
import { findInPath } from '../../services/pty/types';
import * as history from './history';
import { filterCodexChrome, parseCodexChrome, detectCodexSelector } from './parsing';
import { renderCodexBuffer } from './renderer';
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

  async prepareLaunch(): Promise<{ cmd: string; args: string[]; env?: Record<string, string> }> {
    let binary = findInPath('codex');
    if (binary) return { cmd: binary, args: [] };

    // Codex isn't on PATH — run the official installer inline so pairing
    // → first prompt is a single uninterrupted flow on a clean machine.
    // stdio: 'inherit' surfaces npm's progress directly to the user's
    // terminal, so a long download or a permission failure is visible
    // (not silently swallowed).
    console.log('\n  Codex CLI not found — installing via `npm install -g @openai/codex`...\n');
    try {
      await installCodexViaNpm();
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
    augmentNpmGlobalBin();

    binary = findInPath('codex');
    if (!binary) {
      throw new Error(
        'Codex CLI was installed but the binary is not visible on PATH for this process.\n' +
          '    Restart your terminal and run `codeam pair` again.',
      );
    }
    return { cmd: binary, args: [] };
  }

  /** `codex resume <SESSION_ID>` — subcommand, not flag. */
  resumeLaunchArgs(sessionId: string): string[] {
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
}

async function installCodexViaNpm(): Promise<void> {
  return new Promise((resolve, reject) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const proc = spawn(npm, ['install', '-g', '@openai/codex'], {
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

function augmentNpmGlobalBin(): void {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    const result = spawnSync(npm, ['prefix', '-g'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) return;
    const prefix = result.stdout.toString().trim();
    if (!prefix) return;
    // Unix: <prefix>/bin · Windows: <prefix> (npm drops the .cmd shim
    // directly into the prefix dir, not a `bin/` subdir).
    const binDir = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
    const sep = path.delimiter;
    const current = process.env.PATH ?? '';
    const existing = new Set(current.split(sep).filter(Boolean));
    if (!existing.has(binDir)) {
      process.env.PATH = binDir + sep + current;
    }
  } catch {
    /* best effort — the post-install findInPath will still try the
       unmodified PATH and surface a clear error if codex is missing. */
  }
}
