import { log } from './logger';
import { ChromeStepTracker } from './output/chrome-tracker';
import { ChunkEmitter, type SendOutcome } from './output/chunk-emitter';
import { PtyBuffer } from './output/pty-buffer';
import { renderLines } from './output/turn-renderer';
import { createOsStrategy } from '../os';
import type { RuntimeStrategy } from '../agents/strategy';

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
  private readonly runtime: RuntimeStrategy;

  private lastSentContent = '';
  /**
   * Wall-clock of the most recent tick where the rendered + filtered
   * content actually changed. Claude's TUI keeps redrawing the
   * spinner + input prompt after the response is settled, which
   * keeps `pty.lastPushTime` moving and prevents the PTY-idle
   * heuristic from ever crossing the IDLE_MS threshold — so the
   * turn never finalises and `done: true` never reaches the
   * webapp's canonical-refresh path. Tracking content-stability
   * separately closes that hole: PTY can churn all it wants, but
   * once the filtered TUI output stops changing for a beat we
   * know Claude is done.
   */
  private lastContentChangeAt = 0;
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
   * Content-stable threshold. When the rendered + filtered content
   * hasn't changed for this long AND we can see Claude's "? for
   * shortcuts" prompt re-drawn at the bottom (= back to input
   * state), we know the response is settled even though the PTY
   * itself is still pushing spinner / status redraws. Tighter than
   * IDLE_MS because the ready-prompt is a strong signal on its own.
   */
  private static readonly READY_STABLE_MS = 800;
  /**
   * Hard content-stable fallback. If the filtered content has been
   * unchanged for this long, finalize regardless of the ready
   * prompt — covers cases where Claude's TUI doesn't redraw the
   * shortcuts line (older versions, headless runs).
   */
  private static readonly CONTENT_STABLE_MS = 8000;
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
    runtime?: RuntimeStrategy,
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
    // Fall back to a no-op stub so existing callers that don't pass a
    // runtime (tests, legacy entry-points) keep working unchanged.
    // TODO(#50 follow-up): drop this fallback per audit F9 — callers
    // should always pass an explicit runtime. Until then the stub
    // composes the real OsStrategy so the `runtime.os` shape matches.
    this.runtime = runtime ?? {
      id: 'claude' as const,
      meta: { } as RuntimeStrategy['meta'],
      mode: 'interactive' as const,
      os: createOsStrategy(),
      prepareLaunch: async () => ({ cmd: '', args: [] }),
      resumeLaunchArgs: () => [],
      resolveHistoryDir: () => null,
      parseHistoryFile: () => [],
      getCurrentUsage: () => null,
      fetchWeeklyUsage: async () => null,
      listModels: async () => [],
      changeModelInstruction: () => ({ type: 'pty' as const }),
      summarizeInstruction: () => ({ ptyInput: '' }),
      filterTuiOutput: (lines) => lines,
      detectInteractivePrompt: () => null,
      credentialLocator: () => ({
        publicId: 'claude_code',
        vendor: 'Anthropic',
        hint: '',
        watchPaths: () => [],
        extract: async () => null,
      }),
      loginLauncher: () => ({
        ensureInstalled: async () => false,
        launch: () => { throw new Error('login launcher not wired in test stub'); },
      }),
    };
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
    this.lastContentChangeAt = 0;
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

  /**
   * Push a terminal-data chunk for the IDE-integrated terminal
   * panel. Distinct from chat output: `type: 'terminal_data'`
   * lets the host filter the SSE stream by terminal session id.
   * `done: false` because terminal sessions are long-lived — the
   * `terminal_close` command emits the final chunk separately.
   */
  async sendTerminalChunk(terminalSessionId: string, data: string): Promise<void> {
    await this.emitter.send({
      type: 'terminal_data',
      terminalSessionId,
      data,
      done: false,
    });
  }

  /** Final chunk for a terminal session — fires when the PTY
   * exits, so the host can update UI (badge "exit 0", etc). */
  async sendTerminalExit(terminalSessionId: string, exitCode: number): Promise<void> {
    await this.emitter.send({
      type: 'terminal_exit',
      terminalSessionId,
      exitCode,
      done: true,
    });
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

    // Per-agent renderer when the strategy provides one (Codex needs
    // DECSTBM scroll-region support that the shared renderer lacks);
    // otherwise the shared baseline (Claude).
    const lines = this.runtime.renderToLines?.(this.pty.content)
      ?? renderLines(this.pty.content);

    // Emit chrome-step deltas if any new ones surfaced this tick.
    // Route through the per-agent parseTuiChrome so Codex's `•` reply
    // prefix (same glyph as Claude tool-call bullets) is never
    // misclassified as a chrome step.
    const parseLine = this.runtime.parseTuiChrome?.bind(this.runtime) ?? (() => null);
    this.steps.ingest(lines, parseLine);
    const stepsDelta = this.steps.consumeDelta();
    if (stepsDelta.length > 0) {
      this.send({ type: 'chrome_steps', appendSteps: stepsDelta }).catch(() => {});
    }

    const selector = this.runtime.detectInteractivePrompt(lines);
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

    const content = this.runtime.filterTuiOutput(lines).join('\n').replace(/\n{3,}/g, '\n\n').trim();

    if (!content) {
      log.trace(
        'outputSvc',
        `tick empty content (raw=${this.pty.size}B lines=${lines.length} elapsed=${elapsed}ms)`,
      );
      if (elapsed >= OutputService.EMPTY_TIMEOUT_MS) this.finalize();
      return;
    }

    const idleMs = this.pty.lastPushTime > 0 ? now - this.pty.lastPushTime : elapsed;

    // Track content-stability separately from PTY-push-idle. Claude's
    // TUI keeps the spinner / shortcuts redraw bumping
    // `pty.lastPushTime`, so `idleMs` rarely reaches IDLE_MS in
    // practice — without this branch a turn that ended cleanly
    // would never finalise and the webapp's canonical-refresh path
    // (which is gated on `done: true`) would never fire.
    if (content !== this.lastSentContent) {
      this.lastContentChangeAt = now;
      this.lastSentContent = content;
      this.send({ type: 'text', content, done: false }).catch(() => {});
    }
    const contentStableMs = this.lastContentChangeAt > 0 ? now - this.lastContentChangeAt : 0;

    // "Claude is back at the input" — the shortcuts prompt re-appears
    // in the rendered output once the turn is done. Strong signal even
    // when the spinner is still chewing on PTY bytes.
    const readyPrompt = lines.some((l) => /^\?\s.*shortcut/i.test(l.trim()));

    log.trace(
      'outputSvc',
      `tick content (raw=${this.pty.size}B lines=${lines.length} content=${content.length} idleMs=${idleMs} stableMs=${contentStableMs} ready=${readyPrompt})`,
    );

    // PTY-push idle (legacy heuristic — still kicks in for rare cases
    // where Claude's TUI fully halts before redrawing).
    if (idleMs >= OutputService.IDLE_MS) {
      log.trace('outputSvc', `finalize: idleMs=${idleMs}`);
      this.finalize();
      return;
    }
    // Content stable + Claude visible at the input prompt — fastest
    // path. ~800 ms after the response settles.
    if (readyPrompt && contentStableMs >= OutputService.READY_STABLE_MS) {
      log.trace('outputSvc', `finalize: readyPrompt + stableMs=${contentStableMs}`);
      this.finalize();
      return;
    }
    // Hard content-stable fallback — covers older TUIs that don't
    // redraw the shortcuts hint and headless runs.
    if (contentStableMs >= OutputService.CONTENT_STABLE_MS) {
      log.trace('outputSvc', `finalize: stableMs=${contentStableMs} (fallback)`);
      this.finalize();
      return;
    }
  }

  private finalize(): void {
    // Per-agent renderer when the strategy provides one (Codex needs
    // DECSTBM scroll-region support that the shared renderer lacks);
    // otherwise the shared baseline (Claude).
    const lines = this.runtime.renderToLines?.(this.pty.content)
      ?? renderLines(this.pty.content);
    const parseLine = this.runtime.parseTuiChrome?.bind(this.runtime) ?? (() => null);
    this.steps.ingest(lines, parseLine);
    const stepsDelta = this.steps.consumeDelta();
    if (stepsDelta.length > 0) {
      this.send({ type: 'chrome_steps', appendSteps: stepsDelta }).catch(() => {});
    }
    const selector = this.runtime.detectInteractivePrompt(lines);
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
      const content = this.runtime.filterTuiOutput(lines).join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
