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
import { spawnSync } from 'node:child_process';
import { log } from '../../services/logger';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

  async prepareLaunch(): Promise<{
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    sessionId?: string;
  }> {
    const binary = this.os.findInPath('cursor-agent');
    if (!binary) {
      // OS-aware install guidance. On native Windows the Cursor CLI installs via
      // its own PowerShell one-liner (`irm 'https://cursor.com/install?win32=true' | iex`,
      // per cursor.com/docs/cli/installation); on macOS/Linux (and WSL) it ships
      // with the Cursor desktop app / the curl installer.
      const install =
        this.os.id === 'win32'
          ? 'Cursor Agent CLI ("cursor-agent") is not on PATH.\n' +
            "    Install it with:  irm 'https://cursor.com/install?win32=true' | iex\n" +
            '    then run `codeam pair` again.'
          : 'Cursor Agent CLI ("cursor-agent") is not on PATH.\n' +
            '    Install Cursor (https://cursor.com/), enable its CLI plugin,\n' +
            '    then run `codeam pair` again.';
      throw new Error(install);
    }
    // Cursor won't accept an arbitrary pre-set id (`--resume <newid>` on an
    // unknown chat fails), but its `create-chat` command pre-creates an EMPTY
    // resumable chat and prints its id. Pre-minting here — exactly like Claude's
    // `--session-id` — lets the baton bind the conversation the instant the TUI
    // spawns: `AgentService.spawnedSessionId` is known before the first turn, so
    // the NativeTuiDriver never has to guess. We then launch the native TUI
    // attached to that chat with `--resume <id>` (verified live: it opens the TUI
    // cleanly on the empty chat, not "session not found"). Only the baton reaches
    // prepareLaunch — the normal cursor path runs over ACP (`cursor-agent acp`).
    const sessionId = this.mintChatId(binary);
    if (sessionId) {
      const launch = this.os.buildLaunch(binary, ['--resume', sessionId]);
      return { cmd: launch.cmd, args: launch.args, sessionId };
    }
    // create-chat unavailable/failed (offline, old cursor-agent) → launch fresh.
    // The baton then falls back to nothing (no id) and surfaces the normal error;
    // the non-baton ACP path never gets here.
    const launch = this.os.buildLaunch(binary);
    return { cmd: launch.cmd, args: launch.args };
  }

  /**
   * Pre-create an empty, resumable Cursor chat and return its id, or null on any
   * failure. `cursor-agent create-chat` prints a bare UUID and exits 0 (verified
   * on cursor-agent 2026.06.24). Synchronous + bounded so prepareLaunch stays a
   * single deterministic step; a timeout/parse failure just disables pre-mint.
   *
   * ⚠️ Windows: `findInPath` resolves `cursor-agent.cmd` (or `.ps1`) via PATHEXT,
   * and Windows CANNOT spawn a `.cmd`/`.bat`/`.ps1` directly — it needs
   * `cmd.exe /c` / `powershell -File`. Spawning `binary` raw (as this used to)
   * failed with EINVAL on Windows → null id → no pre-mint → the baton threw
   * "agent did not expose a session id after spawn" (Windows-only). Route the
   * spawn through `os.buildLaunch`, exactly like the TUI launch above, so the
   * command is wrapped correctly per-platform. On macOS/Linux buildLaunch returns
   * the bare `{cmd: binary, args: ['create-chat']}` → behaviour unchanged.
   */
  private mintChatId(binary: string): string | null {
    try {
      const launch = this.os.buildLaunch(binary, ['create-chat']);
      const r = spawnSync(launch.cmd, launch.args, {
        encoding: 'utf8',
        timeout: 20_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (r.status !== 0 || r.error) {
        log.warn('cursor', `create-chat failed (status=${r.status}) — baton id pre-mint skipped`);
        return null;
      }
      const id = (r.stdout ?? '').match(UUID_RE)?.[0] ?? null;
      if (!id) log.warn('cursor', 'create-chat produced no chat id — baton id pre-mint skipped');
      return id;
    } catch (err) {
      log.warn('cursor', `create-chat threw: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Cursor mirrors Claude's `--resume <id>` flag for session resume. */
  resumeLaunchArgs(sessionId: string, _opts?: { auto?: boolean }): string[] {
    return ['--resume', sessionId];
  }

  /**
   * Resume as a COMPLETE relaunch (mirrors Claude). The initial spawn already
   * carries `--resume <preMintedId>` from {@link prepareLaunch}, so appending
   * `resumeLaunchArgs` onto `initialLaunch.args` would emit a duplicate
   * `--resume … --resume …`. Rebuild a clean `--resume <id>` launch instead.
   */
  prepareResumeLaunch(sessionId: string, opts?: { auto?: boolean }): {
    cmd: string;
    args: string[];
  } {
    const binary = this.os.findInPath('cursor-agent') ?? this.meta.binaryName;
    const launch = this.os.buildLaunch(binary, this.resumeLaunchArgs(sessionId, opts));
    return { cmd: launch.cmd, args: launch.args };
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

  /**
   * Baton Take Control (native TUI → mobile ACP). Cursor keeps native-TUI
   * conversations in `~/.cursor/chats/<md5(cwd)>/<id>` but ACP `session/load`
   * only reads `~/.cursor/acp-sessions/<id>` — so without this, loading the
   * native session id fails "not found". Bridge the native store into the ACP
   * store just before the load. Best-effort; verified live (identical
   * `blobs`+`meta` SQLite schema, raw file copy replays the conversation).
   */
  async syncTranscriptForAcpResume(cwd: string, sessionId: string): Promise<void> {
    history.bridgeNativeToAcp(cwd, sessionId);
  }

  /**
   * Baton hand-back (mobile ACP → native TUI). Copy the ACP conversation store
   * back into the native `~/.cursor/chats` store so `cursor-agent --resume <id>`
   * in the terminal picks up whatever mobile did. Best-effort.
   */
  async syncTranscriptForNativeResume(cwd: string, sessionId: string): Promise<void> {
    history.bridgeAcpToNative(cwd, sessionId);
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
