/**
 * PTY-backed terminal session manager for the VS Code extension.
 * Mirrors the cli's `terminal-ops.service.ts` byte-for-byte at the
 * wire level so the IDE's TerminalProvider sees identical chunks
 * regardless of which client is paired (cli / vsc / jetbrains).
 *
 * Sessions are keyed by uuid; concurrent cap matches the cli to
 * keep the per-host PTY footprint bounded.
 */
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import * as pty from 'node-pty';
import { SettingsService } from './settings.service';
import { CommandRelayService } from './command-relay.service';

const MAX_CONCURRENT_SESSIONS = 4;

interface Session {
  id: string;
  /** The paired CodeAgent sessionId — the chunk emitter needs this
   * to route terminal data to the right SSE stream. */
  hostSessionId: string;
  pty: pty.IPty;
  dataListener: pty.IDisposable;
  exitListener: pty.IDisposable;
}

export class TerminalOpsService {
  private static instance: TerminalOpsService | null = null;
  static getInstance(): TerminalOpsService {
    if (!this.instance) this.instance = new TerminalOpsService();
    return this.instance;
  }

  private readonly sessions = new Map<string, Session>();
  private readonly log = vscode.window.createOutputChannel('CodeAgent Terminal');

  /** Open a new shell. Returns the opaque session id the host
   * passes to every subsequent write / resize / close.
   * `hostSessionId` is the paired CodeAgent session id (different
   * from the PTY session id we return) — required so data chunks
   * route to the right per-session SSE stream. */
  open(
    hostSessionId: string,
    opts: { cols?: number; rows?: number; cwd?: string },
  ): { sessionId: string } | { error: string } {
    if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      return { error: `Too many open terminals (max ${MAX_CONCURRENT_SESSIONS})` };
    }
    const shell = this.defaultShell();
    const cwd =
      opts.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '1',
    };
    try {
      const term = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: Math.max(1, Math.min(opts.cols ?? 80, 500)),
        rows: Math.max(1, Math.min(opts.rows ?? 24, 200)),
        cwd,
        env,
        useConpty: process.platform === 'win32' ? true : undefined,
      } as pty.IPtyForkOptions & pty.IWindowsPtyForkOptions);
      const id = crypto.randomUUID();
      const dataListener = term.onData((data) => this.pushData(hostSessionId, id, data));
      const exitListener = term.onExit(({ exitCode }) => {
        this.pushExit(hostSessionId, id, exitCode);
        this.sessions.delete(id);
      });
      this.sessions.set(id, { id, hostSessionId, pty: term, dataListener, exitListener });
      return { sessionId: id };
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'spawn failed' };
    }
  }

  write(sessionId: string, data: string): { ok: boolean; error?: string } {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, error: 'No such session' };
    try {
      s.pty.write(data);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'write failed' };
    }
  }

  resize(sessionId: string, cols: number, rows: number): { ok: boolean; error?: string } {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, error: 'No such session' };
    try {
      s.pty.resize(Math.max(1, Math.min(cols, 500)), Math.max(1, Math.min(rows, 200)));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'resize failed' };
    }
  }

  close(sessionId: string): { ok: boolean } {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: true };
    try {
      s.dataListener.dispose();
      s.exitListener.dispose();
      s.pty.kill();
    } catch {
      /* already dead */
    }
    this.sessions.delete(sessionId);
    return { ok: true };
  }

  closeAll(): void {
    for (const id of Array.from(this.sessions.keys())) this.close(id);
  }

  /** Pick a sensible default shell per platform. Mirrors VS Code's
   * own integrated terminal heuristic. */
  private defaultShell(): string {
    if (process.platform === 'win32') {
      return process.env.COMSPEC ?? 'powershell.exe';
    }
    return process.env.SHELL ?? '/bin/bash';
  }

  /** Push a terminal_data chunk via the same /api/commands/output
   * endpoint chat uses. The IDE client filters by
   * `terminalSessionId` to demux multiple concurrent terminals. */
  private pushData(hostSessionId: string, terminalSessionId: string, data: string): void {
    const settings = SettingsService.getInstance();
    const relay = CommandRelayService.getInstance();
    const pluginId = settings.ensurePluginId();
    relay
      .postJson(`${settings.apiBaseUrl}/api/commands/output`, {
        sessionId: hostSessionId,
        pluginId,
        type: 'terminal_data',
        terminalSessionId,
        data,
        done: false,
      })
      .catch((e) => this.log.appendLine(`[terminal] data push failed: ${e}`));
  }

  private pushExit(hostSessionId: string, terminalSessionId: string, exitCode: number): void {
    const settings = SettingsService.getInstance();
    const relay = CommandRelayService.getInstance();
    const pluginId = settings.ensurePluginId();
    relay
      .postJson(`${settings.apiBaseUrl}/api/commands/output`, {
        sessionId: hostSessionId,
        pluginId,
        type: 'terminal_exit',
        terminalSessionId,
        exitCode,
        done: true,
      })
      .catch((e) => this.log.appendLine(`[terminal] exit push failed: ${e}`));
  }
}
