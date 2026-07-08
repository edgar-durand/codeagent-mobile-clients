/**
 * GeminiRuntimeStrategy — InteractiveAgentStrategy for Google's
 * Gemini CLI.
 *
 * Gemini is driven EXCLUSIVELY via the ACP runtime (`gemini --acp`)
 * — see `apps/cli/src/agents/acp/`. The `requiresAcp` dispatch in
 * `start.ts` always routes Gemini through ACP; the PTY-spawn path is
 * never reached. This strategy exists only so the non-spawn code
 * paths that touch every registered agent still resolve cleanly:
 *
 *   - `codeam link gemini` reaches in for `credentialLocator()` +
 *     `loginLauncher()`.
 *   - The agent-contract suite iterates every runtime builder and
 *     asserts the interface shape.
 *
 * `prepareLaunch()` and the TUI-parsing methods below are retained
 * solely to satisfy that contract — production never spawns Gemini
 * over a PTY.
 *
 * History / usage / TUI parsing are deliberately no-ops: Gemini
 * doesn't ship a stable on-disk transcript format we'd want to
 * reverse-engineer, and ACP is the path that fills those gaps in
 * Phase 1.
 */

import {
  getAgent,
  type AgentId,
  type AgentMetadata,
  type AgentModel,
  type NormalizedMessage,
  type SelectPrompt,
} from '@codeam/shared';
import { randomUUID } from 'node:crypto';
import { geminiCredentialLocator, geminiLoginLauncher } from './link';
import * as history from './history';
import { log } from '../../services/logger';
import { spawnAndCapture } from '../../services/spawn-and-capture';
import type { OsStrategy } from '../../os';
import type { ChangeModelInstruction, RuntimeStrategy } from '../strategy';

const GEMINI_PRO_CONTEXT_WINDOW = 1_000_000;
const GEMINI_FLASH_CONTEXT_WINDOW = 1_000_000;

// Subset of model ids the Gemini CLI accepts via `gemini --model
// <id>` (and `/model` once inside the REPL). Kept short on purpose —
// the mobile picker doesn't need to enumerate every variant.
const GEMINI_MODELS: AgentModel[] = [
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    contextWindow: GEMINI_PRO_CONTEXT_WINDOW,
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    contextWindow: GEMINI_FLASH_CONTEXT_WINDOW,
  },
  {
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash-Lite',
    contextWindow: GEMINI_FLASH_CONTEXT_WINDOW,
  },
];

export class GeminiRuntimeStrategy implements RuntimeStrategy {
  readonly id: AgentId = 'gemini';
  readonly meta: AgentMetadata = getAgent('gemini');
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
    const binary = this.os.findInPath('gemini');
    if (!binary) {
      throw new Error(
        'Gemini CLI is not on PATH. Install it with:\n' +
          '    npm install -g @google/gemini-cli\n' +
          '    Then run `codeam pair` again.',
      );
    }
    // Pre-mint the session id and pass it via `--session-id` (Gemini 0.45+:
    // "Start a new session with a manually provided UUID"), same as Claude's
    // `--session-id`. Gemini names its transcript `session-<ts>-<uuid8>.jsonl`
    // and writes our id into the header, so the baton binds `currentConversationId`
    // at spawn and the read-only mirror can locate the file by id — no fs races.
    const sessionId = randomUUID();
    const launch = this.os.buildLaunch(binary, ['--session-id', sessionId]);
    // Observability: gemini's native PTY REPL is exercised (baton) for the first
    // time here — this breadcrumb ties the spawned session id to the transcript
    // the mirror will look for (`session-<ts>-<id8>.jsonl`). If the mirror shows
    // nothing, grep the debug log for this id8 to confirm the id binding.
    log.info(
      'gemini',
      `prepareLaunch — native TUI, binary=${binary} sessionId=${sessionId} (id8=${sessionId.slice(0, 8)})`,
    );
    return { cmd: launch.cmd, args: launch.args, sessionId };
  }

  // Re-attach the same conversation on hand-back (baton) by passing the same
  // `--session-id`. Gemini resolves an existing id to the prior transcript.
  resumeLaunchArgs(sessionId: string, _opts?: { auto?: boolean }): string[] {
    return ['--session-id', sessionId];
  }

  resolveHistoryDir(cwd: string): string | null {
    return history.resolveHistoryDir(cwd);
  }

  /** `~/.gemini/tmp/<project>/chats/session-<ts>-<id8>.jsonl`. Presence of this
   *  method is what lets the baton engage for Gemini (`runtimeSupportsBaton`). */
  resolveHistoryFile(cwd: string, sessionId: string): string | null {
    return history.resolveHistoryFile(cwd, sessionId);
  }

  parseHistoryFile(filePath: string): NormalizedMessage[] {
    return history.parseHistoryFile(filePath);
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
    return GEMINI_MODELS;
  }

  /**
   * Gemini's `/model <id>` swaps the active model inside the REPL —
   * same shape as Claude / Codex / Cursor.
   */
  changeModelInstruction(modelId: string): ChangeModelInstruction {
    return { type: 'pty', ptyInput: `/model ${modelId}\r` };
  }

  /**
   * `/compress` is Gemini's context-compression slash command (the
   * closest analogue to Claude's `/compact`). No auto-mode equivalent.
   */
  summarizeInstruction(_mode: 'normal' | 'auto'): { ptyInput: string } {
    return { ptyInput: '/compress\r' };
  }

  /**
   * Pass-through filter. Gemini runs over ACP, so this is never hit
   * in production — it exists only to satisfy the contract's
   * idempotency assertion. Returning the input verbatim keeps the
   * stub trivially idempotent.
   */
  filterTuiOutput(lines: string[]): string[] {
    return lines;
  }

  /**
   * No interactive-selector detection — Gemini's REPL uses input
   * lines, not arrow-key menus we'd need to detect. ACP surfaces
   * permission requests as typed messages, which is the path we want
   * users on anyway.
   */
  detectInteractivePrompt(_lines: string[]): SelectPrompt | null {
    return null;
  }

  /**
   * Headless single-prompt invocation — the same path Claude / Codex
   * use for `request_ai_summary` + `request_ai_insight` (Files
   * review summaries + per-file insights). Gemini exposes the same
   * pattern via `gemini -p "<prompt>"` which runs in non-interactive
   * print mode, writes the response to stdout, and exits.
   *
   * `--skip-trust` bypasses the workspace trust prompt — required
   * for headless invocations because the prompt would block stdin.
   * Safe because the user already trusted this cwd when they paired
   * the codeam session.
   *
   * Returns `null` on spawn failure / timeout / empty output so the
   * AI handler can silently skip without bubbling a partial reply
   * to the user — same semantics as Claude / Codex above.
   */
  async generateOneShot(
    prompt: string,
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<string | null> {
    const binary = this.os.findInPath('gemini');
    if (!binary) return null;
    const launch = this.os.buildLaunch(binary, ['--skip-trust', '-p', prompt]);
    return spawnAndCapture(launch.cmd, launch.args, {
      cwd: opts?.cwd,
      timeoutMs: opts?.timeoutMs,
    });
  }

  credentialLocator() {
    return geminiCredentialLocator();
  }

  loginLauncher() {
    return geminiLoginLauncher();
  }
}
