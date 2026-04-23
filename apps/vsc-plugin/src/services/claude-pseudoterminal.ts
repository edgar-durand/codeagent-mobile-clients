import * as vscode from 'vscode';
import { ClaudePtyService } from './claude-pty.service';

/**
 * VS Code Pseudoterminal backed by a real `claude` process running
 * under our Python PTY helper. The user sees/types into the terminal
 * as usual; the extension receives every raw byte Claude writes via
 * `onRawData`, which routes into the CLI-compatible output pipeline.
 *
 * This is the only way to get true token-level streaming AND interactive
 * prompt support for Claude Code inside VS Code, since the Claude Code
 * extension's own terminal is an opaque Pseudoterminal that we cannot
 * observe via shell integration.
 */
export class ClaudePseudoterminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;

  private closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidClose = this.closeEmitter.event;

  private pty: ClaudePtyService | null = null;
  private readyResolvers: Array<(ok: boolean) => void> = [];
  private readyState: 'pending' | 'ready' | 'failed' = 'pending';

  constructor(
    private readonly cwd: string,
    private readonly onRawData: (data: string) => void,
    private readonly log: vscode.OutputChannel,
  ) {}

  open(initialDimensions?: vscode.TerminalDimensions): void {
    if (this.pty) return;

    // Cap at 100 cols so Claude Code's welcome banner renders in the
    // inline single-column layout (`▐▛███▜▌ Claude Code` on one line)
    // rather than the wide 2-column layout (logo on left, recent
    // activity on right with `│` separators). The mobile client's
    // `parseClaudeStartup` is written to match the inline format.
    const rawCols = initialDimensions?.columns ?? 100;
    const cols = Math.min(rawCols, 100);
    const rows = initialDimensions?.rows ?? 40;

    this.log.appendLine(`[claude-pty] Spawning claude in PTY (${cols}x${rows}) cwd=${this.cwd}`);

    this.pty = new ClaudePtyService({
      cwd: this.cwd,
      cols,
      rows,
      onData: (data) => {
        this.writeEmitter.fire(data);
        this.onRawData(data);
      },
      onExit: (code) => {
        this.log.appendLine(`[claude-pty] claude exited with code ${code}`);
        this.writeEmitter.fire(`\r\n\x1b[33m[claude exited with code ${code}]\x1b[0m\r\n`);
        this.settleReady(false);
        this.closeEmitter.fire(code);
      },
    });

    const ok = this.pty.spawn();
    if (!ok) {
      this.writeEmitter.fire(
        '\r\n\x1b[31m✗ claude not found in PATH.\r\n  Install with: npm install -g @anthropic-ai/claude-code\x1b[0m\r\n\r\n',
      );
      this.settleReady(false);
      setTimeout(() => this.closeEmitter.fire(1), 100);
      return;
    }

    // The PTY is spawned; mark ready after a small grace period so
    // callers that sendCommand() immediately don't race Claude's TUI
    // setup.
    setTimeout(() => this.settleReady(true), 150);
  }

  close(): void {
    this.pty?.kill();
    this.pty = null;
    this.settleReady(false);
  }

  handleInput(data: string): void {
    this.pty?.write(data);
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    // Same 100-col cap as open() — see comment there for reasoning.
    const cols = Math.min(dimensions.columns, 100);
    this.pty?.resize(cols, dimensions.rows);
  }

  // ─── Programmatic API for TerminalAgentService ───────────────────────

  /** Resolves true once the PTY has spawned, false if spawn failed/exited. */
  async waitForReady(timeoutMs = 5000): Promise<boolean> {
    if (this.readyState === 'ready') return true;
    if (this.readyState === 'failed') return false;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.readyResolvers.push((ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });
  }

  sendCommand(text: string): void { this.pty?.sendCommand(text); }
  selectOption(target: number, from = 0): void { this.pty?.selectOption(target, from); }
  sendEscape(): void { this.pty?.sendEscape(); }
  interrupt(): void { this.pty?.interrupt(); }
  writeRaw(data: string | Buffer): void { this.pty?.write(data); }

  isAlive(): boolean {
    return this.pty?.isAlive() === true;
  }

  private settleReady(ok: boolean): void {
    if (this.readyState !== 'pending') return;
    this.readyState = ok ? 'ready' : 'failed';
    const resolvers = this.readyResolvers;
    this.readyResolvers = [];
    for (const r of resolvers) r(ok);
  }
}
