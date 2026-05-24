import {
  getAgent,
  type AgentId,
  type AgentMetadata,
  type AgentModel,
  type ChromeStep,
  type SelectPrompt,
} from '@codeagent/shared';
import { buildClaudeLaunch } from './resolver';
import { ensureClaudeInstalled } from './installer';
import { claudeCredentialLocator, claudeLoginLauncher } from './link';
import { fetchClaudeQuota } from './quota';
import * as history from './history';
import {
  detectListSelector,
  detectSelector,
  filterChrome,
  isChromeLine,
  parseChromeLine,
} from './parsing';
import type { OsStrategy } from '../../os';
import type { ChangeModelInstruction, RuntimeStrategy } from '../strategy';

export class ClaudeRuntimeStrategy implements RuntimeStrategy {
  readonly id: AgentId = 'claude';
  readonly meta: AgentMetadata = getAgent('claude');
  readonly os: OsStrategy;

  constructor(os: OsStrategy) {
    this.os = os;
  }

  async prepareLaunch(): Promise<{ cmd: string; args: string[]; env?: Record<string, string> }> {
    let launch = buildClaudeLaunch([], this.os);
    if (!launch) {
      // Run Anthropic's official installer inline so pairing → first
      // prompt stays a single uninterrupted flow on a clean machine.
      // The installer prompts interactively (TTY) or runs headless
      // when stdio isn't a TTY.
      const installed = await ensureClaudeInstalled();
      if (installed) launch = buildClaudeLaunch([], this.os);
    }
    if (!launch) {
      const cmd =
        this.os.id === 'win32'
          ? 'irm https://claude.ai/install.ps1 | iex'
          : 'curl -fsSL https://claude.ai/install.sh | bash';
      throw new Error(
        `Claude Code is required to continue. Install it manually with:\n    ${cmd}\n    Then restart your terminal and run \`codeam pair\` again.`,
      );
    }
    return { cmd: launch.cmd, args: launch.args };
  }

  resumeLaunchArgs(sessionId: string, opts?: { auto?: boolean }): string[] {
    const args = ['--resume', sessionId];
    // `--dangerously-skip-permissions` is the auto-reconnect bypass:
    // we only include it when the user already consented to the
    // session and we're re-attaching in the background. User-initiated
    // relaunches (auto=false) re-prompt — the safe default.
    if (opts?.auto) args.push('--dangerously-skip-permissions');
    return args;
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

  async fetchWeeklyUsage() {
    return fetchClaudeQuota();
  }

  async listModels(): Promise<AgentModel[]> {
    // Mirror the Anthropic catalog. Context windows hardcoded — model registry
    // matches what the relay's listModels handler used to return inline.
    return [
      { id: 'claude-opus-4-7',           label: 'Claude Opus 4.7',   contextWindow: 200000 },
      { id: 'claude-opus-4-6',           label: 'Claude Opus 4.6',   contextWindow: 200000 },
      { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6', contextWindow: 200000 },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5',  contextWindow: 200000 },
    ];
  }

  changeModelInstruction(modelId: string): ChangeModelInstruction {
    return { type: 'pty', ptyInput: `/model ${modelId}\r` };
  }

  summarizeInstruction(mode: 'normal' | 'auto'): { ptyInput: string } {
    if (mode === 'normal') return { ptyInput: '/compact\r' };
    // Open question §10.3 — Claude's "AUTO" summarize syntax not yet confirmed.
    // Defaulting to /compact until Spec §10.3 is resolved.
    return { ptyInput: '/compact\r' };
  }

  // ─── TUI parser strategy methods ─────────────────────────────────

  parseTuiChrome(line: string): ChromeStep | null {
    if (!isChromeLine(line)) return null;
    return parseChromeLine(line);
  }

  filterTuiOutput(lines: string[]): string[] {
    return filterChrome(lines);
  }

  detectInteractivePrompt(lines: string[]): SelectPrompt | null {
    // Prefer the numbered `❯ N. label` selector; fall back to the
    // list-style `  ❯ label` selector used by /mcp / /model. Mirrors
    // the legacy call order in OutputService.tick().
    return detectSelector(lines) ?? detectListSelector(lines);
  }

  credentialLocator() {
    return claudeCredentialLocator();
  }

  loginLauncher() {
    return claudeLoginLauncher();
  }
}
