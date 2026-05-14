import { spawn } from 'node:child_process';
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
    const binary = findInPath('codex');
    if (!binary) {
      await installCodexViaNpm();
      const afterInstall = findInPath('codex');
      if (!afterInstall) {
        throw new Error(
          "Could not find 'codex' on PATH after running 'npm install -g @openai/codex'. " +
            'Install it manually and retry.',
        );
      }
      return { cmd: afterInstall, args: [] };
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
    proc.on('error', reject);
  });
}
