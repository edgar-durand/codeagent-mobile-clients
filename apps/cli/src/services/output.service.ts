import { log } from './logger';
import { ChromeStepTracker } from './output/chrome-tracker';
import { ChunkEmitter, type SendOutcome } from './output/chunk-emitter';
import { PtyBuffer } from './output/pty-buffer';
import {
  detectAnySelector,
  extractContent,
  renderLines,
} from './output/turn-renderer';

/**
 * Orchestrator for the CLI's streaming output pipeline.
 *
 * Wires four collaborators each owning one slice of behaviour:
 *
 *   - `PtyBuffer` (data plane) — accumulates raw PTY bytes; flags
 *     terminal-initiated turns when input arrives between turns.
 *   - `ChromeStepTracker` — per-turn cumulative + delta protocol
 *     for thinking-step chunks.
 *   - `ChunkEmitter` (transport) — HTTP POST with retries + auth
 *     header + 410-Gone session-dead detection.
 *   - `turn-renderer` (pure functions) — virtual-terminal render,
 *     selector detection, chrome filtering.
 *
 * The orchestrator owns the per-turn lifecycle (active flag,
 * tick scheduler, finalisation thresholds) — that's the one
 * piece that must coordinate between the four collaborators
 * and so stays here. Everything else delegates.
 */
export class OutputService {
  private readonly pty = new PtyBuffer();
  private readonly steps = new ChromeStepTracker();
  private readonly emitter: ChunkEmitter;

  private lastSentContent = '';
  private pollTimer: NodeJS.Timeout | null = null;
  private startTime = 0;
  private terminalTurnPending = false;

  private readonly onSessionIdDetected?: (sessionId: string) => void;
  private readonly onRateLimitDetected?: (reset: string) => void;
  private readonly onTurnComplete?: () => void;
  private readonly onTerminalTurnDetected?: () => void;

  /** Tick cadence — every 1 s while a turn is active. */
  private static readonly POLL_MS = 1000;
  /** Idle threshold for "the agent's text settled, finalize the turn". */
  private static readonly IDLE_MS = 3000;
  /** Same threshold but tighter for selectors (UI is ready to interact immediately). */
  private static readonly SELECTOR_IDLE_MS = 1500;
  /**
   * Grace period before tick processes anything — Claude needs ~100-
   * 200 ms after `\r` to clear the input echo and re-render the TUI.
   * 1.5 s is a comfortable margin on loaded machines.
   */
  private static readonly WARMUP_MS = 1500;
  /** Max idle with chrome-only output before we stop waiting on the agent. */
  private static readonly EMPTY_TIMEOUT_MS = 60_000;
  /** Hard turn cap — pathological no-op turns get cut after 2 minutes. */
  private static readonly MAX_MS = 120_000;

  constructor(
    sessionId: string,
    pluginId: string,
    onSessionIdDetected?: (sessionId: string) => void,
    onRateLimitDetected?: (reset: string) => void,
    onTurnComplete?: () => void,
    onTerminalTurnDetected?: () => void,
    pluginAuthToken?: string,
  ) {
    this.onSessionIdDetected = onSessionIdDetected;
    this.onRateLimitDetected = onRateLimitDetected;
    this.onTurnComplete = onTurnComplete;
    this.onTerminalTurnDetected = onTerminalTurnDetected;
    this.emitter = new ChunkEmitter({
      sessionId,
      pluginId,
      pluginAuthToken,
    });
  }

  // ─── Turn lifecycle ──────────────────────────────────────────────

  /**
   * Begin a turn driven by a mobile-side prompt. Resets the buffer
   * and emits the boundary chunks (clear → new_turn) that tell
   * clients to wipe the prior agent reply and show "Agent is
   * typing…".
   */
  newTurn(): void {
    log.trace('outputSvc', 'newTurn() — activating output stream');
    this.beginTurn();
    this.send({ type: 'clear' }, { critical: true })
      .then(() => this.send({ type: 'new_turn', done: false }, { critical: true }))
      .catch(() => {});
  }

  /**
   * Begin a turn driven by the user typing locally in their
   * terminal. Same shape as `newTurn` but additionally sends a
   * `user_message` so collaborators see the prompt attributed
   * correctly. `userText` is the prompt text scraped from the
   * Claude JSONL by `historySvc.waitForNewUserMessage`.
   */
  async startTerminalTurn(userText?: string): Promise<void> {
    this.terminalTurnPending = false;
    this.beginTurn();
    await this.send({ type: 'clear' }, { critical: true });
    if (userText) {
      await this.send({ type: 'user_message', content: userText, done: true }, { critical: true });
    }
    await this.send({ type: 'new_turn', done: false }, { critical: true });
  }

  /**
   * Begin a turn after a `resume_session` request. Includes the
   * `resumedSessionId` so the client wipes its history and
   * re-fetches from the JSONL via `get_conversation`.
   */
  async newTurnResume(resumedSessionId: string): Promise<void> {
    this.beginTurn();
    await this.send({ type: 'clear' }, { critical: true });
    await this.send(
      { type: 'new_turn', done: false, resumedSessionId },
      { critical: true },
    );
  }

  // ─── Pump ────────────────────────────────────────────────────────

  push(raw: string): void {
    const result = this.pty.push(raw);
    if (!result.active) {
      if (result.terminalInputDetected && !this.terminalTurnPending) {
        this.terminalTurnPending = true;
        this.onTerminalTurnDetected?.();
      }
      log.trace('outputSvc', `push dropped (inactive, ${raw.length}B)`);
      return;
    }
    log.trace(
      'outputSvc',
      `push +${raw.length}B (buf=${this.pty.size}B)`,
    );
    // Sniff for session id + rate-limit hints in the printable text;
    // these are side-effect callbacks that don't influence the pump.
    this.tryExtractSessionId(raw);
    this.tryDetectRateLimit(raw);
  }

  dispose(): void {
    this.stopPoll();
    this.pty.deactivate();
  }

  // ─── Internals ───────────────────────────────────────────────────

  private beginTurn(): void {
    this.stopPoll();
    this.pty.activate();
    this.steps.reset();
    this.lastSentContent = '';
    this.startTime = Date.now();
    this.pollTimer = setInterval(() => this.tick(), OutputService.POLL_MS);
  }

  private async send(
    body: Record<string, unknown>,
    opts: { critical?: boolean } = {},
  ): Promise<void> {
    const outcome: SendOutcome = await this.emitter.send(body, opts);
    if (outcome.dead && this.pty.isActive) {
      this.dispose();
    }
  }

  private stopPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private tick(): void {
    if (!this.pty.isActive) return;

    const now = Date.now();
    const elapsed = now - this.startTime;

    if (elapsed >= OutputService.MAX_MS) { this.finalize(); return; }

    // Skip early ticks so the renderer sees Claude's settled state,
    // not the raw input echo (which it overwrites within ~100 ms).
    if (elapsed < OutputService.WARMUP_MS) return;

    const lines = renderLines(this.pty.content);

    // Emit chrome-step deltas if any new ones surfaced this tick.
    this.steps.ingest(lines);
    const stepsDelta = this.steps.consumeDelta();
    if (stepsDelta.length > 0) {
      this.send({ type: 'chrome_steps', appendSteps: stepsDelta }).catch(() => {});
    }

    const selector = detectAnySelector(lines);
    if (selector) {
      const idleMs = this.pty.lastPushTime > 0 ? now - this.pty.lastPushTime : elapsed;
      log.trace(
        'outputSvc',
        `tick selector found (idleMs=${idleMs}, options=${selector.options.length})`,
      );
      if (idleMs >= OutputService.SELECTOR_IDLE_MS) {
        this.stopPoll();
        this.pty.deactivate();
        this.send(
          {
            type: 'select_prompt',
            content: selector.question,
            options: selector.options,
            optionDescriptions: selector.optionDescriptions,
            currentIndex: selector.currentIndex,
            done: true,
          },
          { critical: true },
        ).catch(() => {});
      }
      return;
    }

    const content = extractContent(lines);

    if (!content) {
      log.trace(
        'outputSvc',
        `tick empty content (raw=${this.pty.size}B lines=${lines.length} elapsed=${elapsed}ms)`,
      );
      if (elapsed >= OutputService.EMPTY_TIMEOUT_MS) this.finalize();
      return;
    }

    const idleMs = this.pty.lastPushTime > 0 ? now - this.pty.lastPushTime : elapsed;
    log.trace(
      'outputSvc',
      `tick content (raw=${this.pty.size}B lines=${lines.length} content=${content.length} idleMs=${idleMs})`,
    );
    if (idleMs >= OutputService.IDLE_MS) { this.finalize(); return; }

    if (content !== this.lastSentContent) {
      this.lastSentContent = content;
      this.send({ type: 'text', content, done: false }).catch(() => {});
    }
  }

  private finalize(): void {
    const lines = renderLines(this.pty.content);
    this.steps.ingest(lines);
    const stepsDelta = this.steps.consumeDelta();
    if (stepsDelta.length > 0) {
      this.send({ type: 'chrome_steps', appendSteps: stepsDelta }).catch(() => {});
    }
    const selector = detectAnySelector(lines);
    this.stopPoll();
    this.pty.deactivate();

    if (selector) {
      this.send(
        {
          type: 'select_prompt',
          content: selector.question,
          options: selector.options,
          optionDescriptions: selector.optionDescriptions,
          currentIndex: selector.currentIndex,
          done: true,
        },
        { critical: true },
      ).catch(() => {});
    } else {
      const content = extractContent(lines);
      this.send(
        { type: 'text', content, done: true },
        { critical: true },
      ).catch(() => {});
      this.onTurnComplete?.();
    }
  }

  // ─── Side-channel observation (session id + rate limit) ──────────

  private tryExtractSessionId(text: string): void {
    if (!this.onSessionIdDetected) return;
    // Only the explicit `Resuming session: <uuid>` line is safe to
    // bind to. The older broader patterns (`Session: <uuid>`,
    // `Conversation: <uuid>`, `Session ID: <uuid>`) matched any
    // incidental UUID-bearing log line Claude printed and ended
    // up "detecting" the wrong conversation on a fresh pair —
    // including the UUID of a *parallel* Claude session running
    // in the same directory. The fresh-pair flow doesn't need any
    // text-based detection; `detectCurrentConversation()` (filtered
    // by birthtime) handles it after the user's first turn.
    const printable = text.replace(/\x1B\[[^@-~]*[@-~]/g, '').replace(/[\x00-\x1F\x7F]/g, '');
    const match = printable.match(/Resuming session[:\s]+([a-f0-9-]{36})/i);
    if (match) this.onSessionIdDetected(match[1]);
  }

  private tryDetectRateLimit(text: string): void {
    if (!this.onRateLimitDetected) return;
    const printable = text.replace(/\x1B\[[^@-~]*[@-~]/g, '').replace(/[\x00-\x1F\x7F]/g, '');
    const match =
      printable.match(/hit your limit.*resets\s+(.+?)(?:\s*\(|$)/i) ??
      printable.match(/rate.?limit.*resets\s+(.+?)(?:\s*\(|$)/i);
    if (match) {
      this.onRateLimitDetected(match[1].trim());
    }
  }
}

/**
 * Re-export the transport seam so existing test files that import
 * `_transport` from this module keep working without changes.
 */
export { _transport, _post as _sendOutputChunk } from './output/chunk-emitter';
