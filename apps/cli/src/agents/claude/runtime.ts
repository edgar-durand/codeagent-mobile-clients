import {
  getAgent,
  type AgentId,
  type AgentMetadata,
  type AgentModel,
  type SelectPrompt,
} from '@codeam/shared';
import { randomUUID } from 'node:crypto';
import { buildClaudeLaunch } from './resolver';
import { ensureClaudeInstalled } from './installer';
import { claudeCredentialLocator, claudeLoginLauncher } from './link';
import { fetchClaudeQuota } from './quota';
import { spawnAndCapture } from '../../services/spawn-and-capture';
import * as history from './history';
import type { OsStrategy } from '../../os';
import type { ChangeModelInstruction, RuntimeStrategy } from '../strategy';

export class ClaudeRuntimeStrategy implements RuntimeStrategy {
  readonly id: AgentId = 'claude';
  readonly meta: AgentMetadata = getAgent('claude');
  readonly mode = 'interactive' as const;
  readonly os: OsStrategy;

  constructor(os: OsStrategy) {
    this.os = os;
  }

  /**
   * Claude Code's react-ink TUI enables bracketed-paste mode at
   * boot (`ESC[?2004h`). When a multi-line write arrives, Claude
   * opens a paste boundary that stays open until it sees the
   * matching `ESC[201~` end marker. A naïve `text + \r` lands the
   * `\r` INSIDE the open bracket as paste CONTENT, and the prompt
   * sits in the input forever (the user's mobile COMMENT flow was
   * stacking `[Pasted text #N]` markers with no submit).
   *
   * Fix: wrap multi-line prompts in the bracket markers ourselves
   * so the end marker closes the paste deterministically. The
   * caller emits `\r` 80 ms later — now OUTSIDE the bracket — and
   * Claude's input handler treats it as a normal Submit. Single-
   * line prompts don't trigger paste mode so we keep the bare
   * `text + \r` path for that case.
   */
  prepareInputWrites(text: string): { writes: string[]; submitDelayMs: number } {
    if (text.includes('\n')) {
      return {
        writes: [`\x1b[200~${text}\x1b[201~`],
        submitDelayMs: 80,
      };
    }
    return { writes: [text], submitDelayMs: 50 };
  }

  async prepareLaunch(): Promise<{
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    sessionId?: string;
  }> {
    // Pre-mint the session id and pass it to Claude via
    // `--session-id`. Claude opens / creates a JSONL named after
    // this id, so the CLI binds `currentConversationId` at spawn
    // time and never has to inspect the filesystem to figure out
    // which JSONL is "ours" — works on every OS by construction
    // (no lsof / procfs / fs.watch races, no birthtime heuristic).
    const sessionId = randomUUID();
    const sessionArgs = ['--session-id', sessionId];
    let launch = buildClaudeLaunch(sessionArgs, this.os);
    if (!launch) {
      // Run Anthropic's official installer inline so pairing → first
      // prompt stays a single uninterrupted flow on a clean machine.
      // The installer prompts interactively (TTY) or runs headless
      // when stdio isn't a TTY.
      const installed = await ensureClaudeInstalled();
      if (installed) launch = buildClaudeLaunch(sessionArgs, this.os);
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
    return { cmd: launch.cmd, args: launch.args, sessionId };
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

  /**
   * Resume relaunch as a COMPLETE command. We deliberately rebuild the
   * launch from scratch with `--resume <id>` rather than appending it
   * onto the spawn-time args, because those carried `--session-id
   * <uuid>` (the conversation binding from the initial spawn). Claude
   * Code rejects `--session-id` together with `--resume` and exits
   * immediately — that was the "resume → agent fully dead, even new
   * prompts get no response" bug. Building a fresh launch drops the
   * conflicting flag by construction.
   *
   * Synchronous on purpose: by the time a resume happens the binary
   * was already resolved (the initial spawn succeeded), so
   * `buildClaudeLaunch` re-probes PATH without needing the async
   * installer fallback.
   */
  prepareResumeLaunch(
    sessionId: string,
    opts?: { auto?: boolean },
  ): { cmd: string; args: string[] } {
    const launch = buildClaudeLaunch(this.resumeLaunchArgs(sessionId, opts), this.os);
    if (!launch) {
      // Should never happen post-initial-spawn, but stay defensive:
      // fall back to the binary name + resume args so the caller can
      // still attempt a relaunch instead of throwing into a sync path.
      return { cmd: this.meta.binaryName, args: this.resumeLaunchArgs(sessionId, opts) };
    }
    return launch;
  }

  resolveHistoryDir(cwd: string): string | null {
    return history.resolveHistoryDir(cwd);
  }

  resolveHistoryFile(cwd: string, sessionId: string): string | null {
    return history.resolveHistoryFile(cwd, sessionId);
  }

  parseHistoryFile(filePath: string) {
    return history.parseHistoryFile(filePath);
  }

  getCurrentUsage(historyDir: string) {
    return history.getCurrentUsage(historyDir);
  }

  listResumableSessions(cwd: string) {
    return history.listResumableSessions(cwd);
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
  // Claude runs ACP-only (see the `requiresAcp` dispatch in start.ts),
  // so the legacy PTY-spawn pipeline never reaches these. They remain
  // as inert stubs purely to satisfy the InteractiveAgentStrategy
  // contract; the React-Ink TUI parsers were removed with the PTY path.
  // The optional TUI hooks (parseTuiChrome / detectReadyPrompt /
  // detectStartupBanner / detectInputSuggestion) are dropped entirely.

  filterTuiOutput(lines: string[]): string[] {
    return lines;
  }

  detectInteractivePrompt(_lines: string[]): SelectPrompt | null {
    return null;
  }

  credentialLocator() {
    return claudeCredentialLocator();
  }

  loginLauncher() {
    return claudeLoginLauncher();
  }

  async generateOneShot(
    prompt: string,
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<string | null> {
    // `claude -p "<prompt>"` is Anthropic's officially-supported print
    // mode — runs in non-interactive headless mode, prints the response
    // to stdout, and exits. Safe to spawn alongside the user's primary
    // interactive session because it's a brand-new child process (no
    // shared PTY, no state mutation in the user's active conversation).
    const launch = buildClaudeLaunch(['-p', prompt], this.os);
    if (!launch) return null;
    return spawnAndCapture(launch.cmd, launch.args, {
      cwd: opts?.cwd,
      timeoutMs: opts?.timeoutMs,
    });
  }
}
