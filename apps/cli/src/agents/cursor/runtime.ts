/**
 * CursorRuntimeStrategy — InteractiveAgentStrategy for Cursor Agent.
 *
 * Cursor's `cursor-agent` CLI ships as part of the Cursor desktop
 * install; we don't bundle an auto-installer (the binary lives
 * inside the Cursor app bundle on macOS, the Cursor install dir on
 * Windows). When the binary isn't on PATH the user is guided to
 * install Cursor first via the link-launcher's `ensureInstalled`.
 *
 * Currently gated by `AGENT_REGISTRY.cursor.enabled = false` — flip
 * after the contract test (#62) is green against a real PTY capture.
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
import { cursorCredentialLocator, cursorLoginLauncher } from './link';
import { detectCursorSelector, filterCursorChrome, parseCursorChrome } from './parsing';
import type { OsStrategy } from '../../os';
import type { ChangeModelInstruction, RuntimeStrategy } from '../strategy';
import { spawnAndCapture } from '../../services/spawn-and-capture';

const CURSOR_CONTEXT_WINDOW = 200_000;

const CURSOR_MODELS: AgentModel[] = [
  { id: 'cursor-default', label: 'Cursor (auto)', contextWindow: CURSOR_CONTEXT_WINDOW },
  { id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet (via Cursor)', contextWindow: CURSOR_CONTEXT_WINDOW },
  { id: 'gpt-4o', label: 'GPT-4o (via Cursor)', contextWindow: CURSOR_CONTEXT_WINDOW },
];

export class CursorRuntimeStrategy implements RuntimeStrategy {
  readonly id: AgentId = 'cursor';
  readonly meta: AgentMetadata = getAgent('cursor');
  readonly mode = 'interactive' as const;
  readonly os: OsStrategy;

  constructor(os: OsStrategy) {
    this.os = os;
  }

  async prepareLaunch(): Promise<{ cmd: string; args: string[]; env?: Record<string, string> }> {
    const binary = this.os.findInPath('cursor-agent');
    if (!binary) {
      throw new Error(
        'Cursor Agent CLI ("cursor-agent") is not on PATH.\n' +
          '    Install Cursor (https://cursor.com/), enable its CLI plugin,\n' +
          '    then run `codeam pair` again.',
      );
    }
    return this.os.buildLaunch(binary);
  }

  /** Cursor mirrors Claude's `--resume <id>` flag for session resume. */
  resumeLaunchArgs(sessionId: string, _opts?: { auto?: boolean }): string[] {
    return ['--resume', sessionId];
  }

  resolveHistoryDir(cwd: string): string | null {
    return history.resolveHistoryDir(cwd);
  }

  /** Session transcript at
   *  `~/.cursor/projects/<encoded-cwd>/agent-transcripts/<id>/<id>.jsonl`.
   *  Presence of this method is what lets the baton engage for Cursor
   *  (`runtimeSupportsBaton`), so the LOCAL_DRIVE mirror can tail it. */
  resolveHistoryFile(cwd: string, sessionId: string): string | null {
    return history.resolveHistoryFile(cwd, sessionId);
  }

  parseHistoryFile(filePath: string) {
    return history.parseHistoryFile(filePath);
  }

  getCurrentUsage(historyDir: string) {
    return history.getCurrentUsage(historyDir);
  }

  /** Cursor's usage RPC isn't surfaced through the CLI today;
   *  returning null surfaces "—" in the mobile UI, matching Codex. */
  async fetchWeeklyUsage(): Promise<{ percent: number; resetAt?: string } | null> {
    return null;
  }

  async listModels(): Promise<AgentModel[]> {
    return CURSOR_MODELS;
  }

  /**
   * One-shot headless generation — powers preview detection + AI summaries.
   * `--print` = non-interactive; `--trust` bypasses the workspace-trust gate
   * (no human at the box to approve, only works with --print); `--force`
   * auto-allows tool calls. Auth comes from the login state the provisioner
   * writes (~/.config/cursor/auth.json), NOT CURSOR_API_KEY. Returns null on
   * spawn failure / timeout / empty output so callers silently skip — same
   * semantics as Claude / Codex / Gemini.
   */
  async generateOneShot(
    prompt: string,
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<string | null> {
    const binary = this.os.findInPath('cursor-agent');
    if (!binary) return null;
    const launch = this.os.buildLaunch(binary, ['--print', '--force', '--trust', prompt]);
    return spawnAndCapture(launch.cmd, launch.args, {
      cwd: opts?.cwd,
      timeoutMs: opts?.timeoutMs,
    });
  }

  changeModelInstruction(modelId: string): ChangeModelInstruction {
    return { type: 'pty', ptyInput: `/model ${modelId}\r` };
  }

  /** Cursor accepts `/compact` like Claude + Codex. */
  summarizeInstruction(_mode: 'normal' | 'auto'): { ptyInput: string } {
    return { ptyInput: '/compact\r' };
  }

  // ─── TUI parser strategy methods ─────────────────────────────────

  parseTuiChrome(line: string): ChromeStep | null {
    return parseCursorChrome(line);
  }

  filterTuiOutput(lines: string[]): string[] {
    return filterCursorChrome(lines);
  }

  detectInteractivePrompt(lines: string[]): SelectPrompt | null {
    return detectCursorSelector(lines);
  }

  detectReadyPrompt(lines: string[]): boolean {
    // cursor-agent shares ratatui chrome with Codex — same box-
    // bordered input bar with the `›` cursor at the bottom when
    // the agent is idle. Conservative regex: any line with a box
    // bar adjacent to `›` (or the ASCII fallback `>` ratatui shows
    // when the user's terminal lacks the Unicode glyph).
    return lines.some((l) => /[│┃]\s*[›>]\s/u.test(l));
  }

  credentialLocator() {
    return cursorCredentialLocator();
  }

  loginLauncher() {
    return cursorLoginLauncher(this.os);
  }
}
