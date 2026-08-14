/**
 * AiderRuntimeStrategy — InteractiveAgentStrategy for Aider.
 *
 * Aider differs from Claude / Codex / Cursor in three load-bearing
 * ways:
 *
 *   1. **Auth is env-var-driven.** Aider reads ANTHROPIC_API_KEY /
 *      OPENAI_API_KEY / etc. at startup; there's no OAuth flow. The
 *      link command surfaces this via the existing `--api-key` /
 *      `--api-key-file` escape hatches.
 *   2. **Model selection is via launch flag.** Aider's `--model
 *      <id>` CLI flag picks the model up front; the runtime
 *      currently leaves `--model` unset and lets Aider's auto-pick
 *      run, which selects based on which API key is present.
 *   3. **Install path is pip.** No auto-installer (we won't shell
 *      out to pip on the user's machine without explicit consent).
 *      `ensureInstalled` surfaces a clear "pip install aider-chat"
 *      message instead.
 *
 * Currently gated by `AGENT_REGISTRY.aider.enabled = false`.
 */

import {
  getAgent,
  type AgentId,
  type AgentMetadata,
  type AgentModel,
  type ChromeStep,
  type SelectPrompt,
} from '@codeam/shared';
import * as history from './history';
import { aiderCredentialLocator, aiderLoginLauncher } from './link';
import { detectAiderSelector, filterAiderChrome, parseAiderChrome } from './parsing';
import type { OsStrategy } from '../../os';
import { augmentUserLocalBinPaths } from '../acp/agent-binary';
import type { ChangeModelInstruction, RuntimeStrategy } from '../strategy';

const AIDER_CONTEXT_WINDOW = 200_000;

// Representative subset of model ids Aider supports. The list is
// intentionally short — Aider supports ~50 models across providers
// and showing all of them in the mobile model picker would be
// noise. Users who want a specific model use Aider's own /model
// command inside the REPL (or pass it via env / config).
const AIDER_MODELS: AgentModel[] = [
  { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet', contextWindow: AIDER_CONTEXT_WINDOW },
  { id: 'claude-3-opus-20240229',    label: 'Claude 3 Opus',    contextWindow: AIDER_CONTEXT_WINDOW },
  { id: 'gpt-4o',                    label: 'GPT-4o',           contextWindow: 128_000 },
  { id: 'o1-preview',                label: 'OpenAI o1-preview', contextWindow: 128_000 },
  { id: 'deepseek/deepseek-chat',    label: 'DeepSeek Chat',    contextWindow: 64_000 },
];

export class AiderRuntimeStrategy implements RuntimeStrategy {
  readonly id: AgentId = 'aider';
  readonly meta: AgentMetadata = getAgent('aider');
  readonly mode = 'interactive' as const;
  readonly os: OsStrategy;

  constructor(os: OsStrategy) {
    this.os = os;
  }

  async prepareLaunch(): Promise<{ cmd: string; args: string[]; env?: Record<string, string> }> {
    // ⚠️ Stale-PATH guard — same class as codex/gemini/cursor's ACP
    // `waitForBinary` branches. `pip install aider-chat` on a non-root box
    // prints "Defaulting to user installation because normal site-packages is
    // not writeable" and lands the console script in ~/.local/bin, which a
    // long-running daemon started with a systemd-minimal PATH never has. The
    // bare probe then throws "Aider is not on PATH. Install it with: pip
    // install aider-chat" on a box where aider IS installed. Caught by the
    // real per-agent install gate
    // (`__tests__/integration/agent-install.int.test.ts`).
    augmentUserLocalBinPaths();
    const binary = this.os.findInPath('aider');
    if (!binary) {
      throw new Error(
        'Aider is not on PATH. Install it with:\n' +
          '    pip install aider-chat\n' +
          '    Then run `codeam pair` again.',
      );
    }
    // No default args — Aider auto-picks a model based on which API
    // key is in the environment. Users wanting a specific model use
    // /model inside the REPL.
    return this.os.buildLaunch(binary);
  }

  /** Aider supports `--restore-chat-history` to reload the last
   *  session in the current cwd. We pass it alongside `--message`
   *  with the session id so the resume is observable. */
  resumeLaunchArgs(_sessionId: string, _opts?: { auto?: boolean }): string[] {
    return ['--restore-chat-history'];
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

  async fetchWeeklyUsage(): Promise<{ percent: number; resetAt?: string } | null> {
    return null;
  }

  async listModels(): Promise<AgentModel[]> {
    return AIDER_MODELS;
  }

  /**
   * Aider's `/model <id>` slash command swaps the active model mid-
   * session. Same pattern as Claude/Codex/Cursor.
   */
  changeModelInstruction(modelId: string): ChangeModelInstruction {
    return { type: 'pty', ptyInput: `/model ${modelId}\r` };
  }

  /** Aider's `/clear` resets context — the closest analogue to the
   *  compaction other agents do. No auto-mode equivalent. */
  summarizeInstruction(_mode: 'normal' | 'auto'): { ptyInput: string } {
    return { ptyInput: '/clear\r' };
  }

  parseTuiChrome(line: string): ChromeStep | null {
    return parseAiderChrome(line);
  }

  filterTuiOutput(lines: string[]): string[] {
    return filterAiderChrome(lines);
  }

  detectInteractivePrompt(lines: string[]): SelectPrompt | null {
    return detectAiderSelector(lines);
  }

  detectReadyPrompt(lines: string[]): boolean {
    // Aider's interactive shell prints a bare `>` line for input
    // OR the `>` followed by a space when the cursor is parked.
    // Also accept the `... >` continuation prompt that appears
    // during multi-line edits.
    return lines.some((l) => {
      const t = l.replace(/\x1B\[[^@-~]*[@-~]/g, '').trim();
      return t === '>' || /^>\s*$/.test(t) || /^\.\.\.\s*>\s*$/.test(t);
    });
  }

  credentialLocator() {
    return aiderCredentialLocator();
  }

  loginLauncher() {
    return aiderLoginLauncher(this.os);
  }
}
