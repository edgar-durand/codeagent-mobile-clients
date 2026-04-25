import * as os from 'os';
import * as vscode from 'vscode';
import { OutputChannel } from 'vscode';
import { SettingsService } from './settings.service';
import { CommandRelayService } from './command-relay.service';
import { ClaudePseudoterminal } from './claude-pseudoterminal';
import { ClaudeContextService } from './claude-context.service';
import {
  renderToLines,
  detectSelector,
  detectListSelector,
  filterChrome,
} from './terminal-output-pipeline';
import { isChromeLine, parseChromeLine, ChromeStep } from './parseChrome';

/**
 * Owns a PTY-wrapped `claude` process displayed inside a VS Code
 * custom terminal (`ClaudePseudoterminal`). Every byte Claude writes
 * is captured in a raw buffer and fed through the same pipeline
 * codeam-cli uses (`renderToLines` → `detectSelector` → `filterChrome`),
 * producing the exact same SSE chunk stream the mobile client already
 * knows how to render.
 *
 * The Claude Code VS Code extension creates its own opaque
 * Pseudoterminal that is not observable via shell integration, so we
 * spawn a second claude process under our control rather than try to
 * tap into theirs. Users will see a "Claude Code" terminal created
 * by CodeAgent; they can close their pre-existing one if desired.
 */
export class TerminalAgentService {
  private static instance: TerminalAgentService;
  private log: OutputChannel;

  // Distinctive name so:
  //   (a) we can tell it apart from the Claude Code extension's own
  //       "Claude Code" terminal (avoiding double-spawn confusion);
  //   (b) on plugin reactivation we can reap orphaned terminals left
  //       behind by the previous plugin instance (their Pseudoterminal
  //       is dead but the tab lingers in VS Code's UI).
  private static readonly TERMINAL_NAME = 'Claude Code (CodeAgent)';

  // The PTY-backed terminal and its raw byte stream.
  private pseudoterminal: ClaudePseudoterminal | null = null;
  private terminal: vscode.Terminal | null = null;
  private rawBuffer = '';

  // Active turn state (one turn at a time — matches CLI semantics).
  private currentSessionId: string | null = null;
  private baselineLength = 0;
  private lastSentContent = '';
  private lastSentChromeStepsJson = '';
  private chromeStepsHistory: ChromeStep[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private startTime = 0;
  private isActive = false;
  private lastPushTime = 0;

  // Serial queue so chunks reach the API in the order they were produced.
  private pushQueue: Promise<unknown> = Promise.resolve();

  private static readonly POLL_MS = 1000;
  private static readonly IDLE_MS = 3000;
  private static readonly SELECTOR_IDLE_MS = 1500;
  private static readonly WARMUP_MS = 1500;
  private static readonly EMPTY_TIMEOUT_MS = 60_000;
  private static readonly MAX_MS = 120_000;

  private constructor(log: OutputChannel) {
    this.log = log;

    // Reap orphans: when VS Code auto-updates the extension, the old
    // Pseudoterminal is torn down but its terminal tab stays in the
    // sidebar as a dead entry. Dispose any we find at activate time
    // so the user doesn't end up with a growing pile of ghost tabs.
    for (const term of vscode.window.terminals) {
      if (term.name === TerminalAgentService.TERMINAL_NAME) {
        this.log.appendLine(`[terminal] Disposing orphan terminal from previous activation: ${term.name}`);
        try { term.dispose(); } catch { /* ignore */ }
      }
    }

    vscode.window.onDidCloseTerminal((closed) => {
      if (closed === this.terminal) {
        this.log.appendLine('[terminal] Claude PTY terminal closed by user');
        this.pseudoterminal = null;
        this.terminal = null;
        this.rawBuffer = '';
        this.stopMonitoring();
      }
    });
  }

  static initialize(log: OutputChannel): TerminalAgentService {
    TerminalAgentService.instance = new TerminalAgentService(log);
    return TerminalAgentService.instance;
  }

  static getInstance(): TerminalAgentService {
    if (!TerminalAgentService.instance) {
      throw new Error('TerminalAgentService not initialized');
    }
    return TerminalAgentService.instance;
  }

  /** Returns our own PTY-backed terminal if it exists. */
  findClaudeCodeTerminal(): vscode.Terminal | null {
    return this.terminal;
  }

  isClaudeCodeAvailable(): boolean {
    return this.pseudoterminal?.isAlive() === true;
  }

  private async ensureClaudeTerminal(): Promise<boolean> {
    if (this.pseudoterminal?.isAlive() && this.terminal) return true;

    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

    this.pseudoterminal = new ClaudePseudoterminal(
      cwd,
      (data) => {
        this.rawBuffer += data;
        // Scrape rate-limit + weekly-quota notices out of the raw
        // stream so get_context can surface them to mobile, matching
        // what codeam-cli's HistoryService already tracks.
        try {
          const ctx = ClaudeContextService.getInstance();
          ctx.tryDetectRateLimit(data);
          ctx.tryDetectQuota(data);
        } catch { /* not initialized — ignore */ }
      },
      this.log,
    );

    this.terminal = vscode.window.createTerminal({
      name: TerminalAgentService.TERMINAL_NAME,
      pty: this.pseudoterminal,
    });
    this.terminal.show();

    const ok = await this.pseudoterminal.waitForReady(5000);
    if (!ok) {
      this.log.appendLine('[terminal] Claude PTY failed to spawn within 5s');
      this.pseudoterminal = null;
      this.terminal?.dispose();
      this.terminal = null;
      return false;
    }
    this.log.appendLine('[terminal] Claude PTY ready');
    return true;
  }

  /** Send a prompt from a remote source (mobile). Spawns the PTY on first use. */
  async sendPromptToClaudeCode(prompt: string): Promise<boolean> {
    const ok = await this.ensureClaudeTerminal();
    if (!ok || !this.pseudoterminal) return false;

    // Wait until Claude's TUI advertises an input-ready prompt
    // ("? for shortcuts"). On cold start this blocks for the full
    // welcome-render duration (~2-3 s). On subsequent prompts the
    // marker is already in the buffer from the previous idle state
    // so this returns after the first poll.
    //
    // Idle-based detection was not reliable: the welcome render has
    // internal pauses longer than 800 ms, and an 800 ms idle triggered
    // a premature send whose keystrokes were then dropped by React
    // Ink before the input widget had mounted.
    await this.waitForInputReady(10000);

    this.pseudoterminal.sendCommand(prompt);
    this.log.appendLine(`[terminal] Sent prompt to Claude PTY: ${prompt.substring(0, 60)}`);
    return true;
  }

  /** Poll rawBuffer until Claude's idle input marker appears, or timeout. */
  private async waitForInputReady(maxMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 150));
      if (/\?\s+for\s+shortcuts/i.test(this.rawBuffer)) {
        // Small grace so any final TUI re-render settles before the
        // remote keystrokes arrive.
        await new Promise((r) => setTimeout(r, 250));
        this.log.appendLine(
          `[terminal] Claude input ready after ${Date.now() - start}ms`,
        );
        return true;
      }
    }
    this.log.appendLine(`[terminal] Claude input never became ready (${maxMs}ms timeout)`);
    return false;
  }

  /** Raw write — used by resume_session to send Ctrl+C before relaunching. */
  sendRawToTerminal(text: string): boolean {
    if (!this.pseudoterminal?.isAlive()) return false;
    this.pseudoterminal.writeRaw(text);
    return true;
  }

  /** Navigate a selector to the target index, then press Enter. */
  async selectOption(targetIndex: number, currentIndex = 0): Promise<boolean> {
    if (!this.pseudoterminal?.isAlive()) return false;
    this.pseudoterminal.selectOption(targetIndex, currentIndex);
    return true;
  }

  sendEscape(): boolean {
    if (!this.pseudoterminal?.isAlive()) return false;
    this.pseudoterminal.sendEscape();
    return true;
  }

  /**
   * Begin a new turn. Snapshots the current raw buffer length so
   * output produced from here on is processed relative to this
   * baseline, emits CLI-compatible `clear` + `new_turn` chunks,
   * and starts the tick loop that pushes streaming text,
   * chrome_steps, and select_prompt chunks.
   */
  startMonitoring(sessionId: string, prompt: string): void {
    // Re-entry guard: if a previous tick loop is still active for an
    // earlier turn, drop this call rather than tearing it down and
    // double-spawning. Two rapid `startMonitoring` calls (e.g. a user
    // double-fires a prompt) would otherwise leave two interval timers
    // racing on the same rawBuffer.
    if (this.isActive) {
      this.log.appendLine(
        `[terminal] startMonitoring: ignoring re-entry while session=${this.currentSessionId} is active`,
      );
      return;
    }

    this.stopMonitoring();

    if (!this.pseudoterminal?.isAlive()) {
      this.log.appendLine('[terminal] startMonitoring: Claude PTY is not alive');
      return;
    }

    this.currentSessionId = sessionId;
    void prompt;
    this.isActive = true;
    this.lastSentContent = '';
    this.lastSentChromeStepsJson = '';
    this.chromeStepsHistory = [];
    this.lastPushTime = 0;
    this.startTime = Date.now();
    // Reset the raw buffer so `renderToLines` processes only this
    // turn's output — mirrors codeam-cli's OutputService.newTurn().
    // Any pre-turn state (welcome screen, previous response) stays
    // visible in the VS Code terminal because writeEmitter fires
    // independently of rawBuffer.
    this.rawBuffer = '';
    this.baselineLength = 0;

    // CLI-compatible turn start so the client creates exactly one
    // streaming placeholder bubble and turns on the typing indicator.
    this.pushChunk(sessionId, { clear: true });
    this.pushChunk(sessionId, { type: 'new_turn', content: '', done: false });

    this.pollTimer = setInterval(
      () => this.tick(),
      TerminalAgentService.POLL_MS,
    );

    this.log.appendLine(
      `[terminal] Monitoring session=${sessionId} (baseline=${this.baselineLength} bytes)`,
    );
  }

  stopMonitoring(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isActive = false;
    this.currentSessionId = null;
    this.baselineLength = 0;
  }

  private tick(): void {
    if (!this.isActive || !this.currentSessionId) return;

    const now = Date.now();
    const elapsed = now - this.startTime;

    if (elapsed >= TerminalAgentService.MAX_MS) {
      this.finalize();
      return;
    }

    if (elapsed < TerminalAgentService.WARMUP_MS) return;

    const lines = renderToLines(this.rawBuffer);
    this.postChromeSteps(lines);

    const selector = detectSelector(lines) ?? detectListSelector(lines);
    if (selector) {
      const idleMs = this.lastPushTime > 0 ? now - this.lastPushTime : elapsed;
      if (idleMs >= TerminalAgentService.SELECTOR_IDLE_MS) {
        this.pushChunk(this.currentSessionId, {
          type: 'select_prompt',
          content: selector.question,
          options: selector.options,
          optionDescriptions: selector.optionDescriptions,
          currentIndex: selector.currentIndex,
          done: true,
        });
        this.stopMonitoring();
      }
      return;
    }

    const content = filterChrome(lines)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!content) {
      if (elapsed >= TerminalAgentService.EMPTY_TIMEOUT_MS) this.finalize();
      return;
    }

    const idleMs = this.lastPushTime > 0 ? now - this.lastPushTime : elapsed;
    if (idleMs >= TerminalAgentService.IDLE_MS) {
      this.finalize();
      return;
    }

    if (content !== this.lastSentContent) {
      this.lastSentContent = content;
      this.pushChunk(this.currentSessionId, {
        type: 'text',
        content,
        done: false,
      });
      this.lastPushTime = Date.now();
    }
  }

  private finalize(): void {
    if (!this.currentSessionId) {
      this.stopMonitoring();
      return;
    }
    const sessionId = this.currentSessionId;
    const lines = renderToLines(this.rawBuffer);
    this.postChromeSteps(lines);

    const selector = detectSelector(lines) ?? detectListSelector(lines);
    if (selector) {
      this.pushChunk(sessionId, {
        type: 'select_prompt',
        content: selector.question,
        options: selector.options,
        optionDescriptions: selector.optionDescriptions,
        currentIndex: selector.currentIndex,
        done: true,
      });
    } else {
      const content = filterChrome(lines)
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      this.pushChunk(sessionId, { type: 'text', content, done: true });
    }
    this.stopMonitoring();
  }

  private postChromeSteps(lines: string[]): void {
    if (!this.currentSessionId) return;
    const visible = lines
      .filter((l) => isChromeLine(l))
      .map((l) => parseChromeLine(l))
      .filter((s): s is ChromeStep => s !== null);
    if (visible.length === 0) return;

    let changed = false;
    for (const step of visible) {
      const exists = this.chromeStepsHistory.some(
        (s) => s.tool === step.tool && s.label === step.label,
      );
      if (!exists) {
        this.chromeStepsHistory.push(step);
        changed = true;
      }
    }
    if (!changed) return;

    const json = JSON.stringify(this.chromeStepsHistory);
    if (json === this.lastSentChromeStepsJson) return;
    this.lastSentChromeStepsJson = json;

    this.pushChunk(this.currentSessionId, {
      type: 'chrome_steps',
      content: '',
      steps: [...this.chromeStepsHistory],
    });
  }

  private pushChunk(sessionId: string, body: Record<string, unknown>): void {
    const settings = SettingsService.getInstance();
    const relay = CommandRelayService.getInstance();
    const pluginId = settings.ensurePluginId();
    this.pushQueue = this.pushQueue
      .then(() =>
        relay.postJson(`${settings.apiBaseUrl}/api/commands/output`, {
          sessionId,
          pluginId,
          ...body,
        }),
      )
      .catch((e) => this.log.appendLine(`[terminal] push error: ${e}`));
  }
}
