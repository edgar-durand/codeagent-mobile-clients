import * as https from 'https';
import * as http from 'http';
import {
  detectListSelector,
  detectSelector,
  filterChrome,
  isChromeLine,
  parseChromeLine,
  renderToLines,
  type ChromeStep,
} from '@codeagent/shared';

const API_BASE = process.env.CODEAM_API_URL ?? 'https://codeagent-mobile-api.vercel.app';

// Virtual terminal (renderToLines), selector detection, and chrome filter
// all live in @codeagent/shared so the VS Code extension processes PTY
// output byte-for-byte identically to this CLI.


export class OutputService {
  private rawBuffer = '';
  private lastSentContent = '';
  private lastSentChromeStepsJson = '';
  private chromeStepsHistory: ChromeStep[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private startTime = 0;
  private active = false;
  private terminalTurnPending = false;
  private lastPushTime = 0;
  private onSessionIdDetected?: (sessionId: string) => void;
  private onRateLimitDetected?: (reset: string) => void;
  private onTurnComplete?: () => void;
  private onTerminalTurnDetected?: () => void;

  private static readonly POLL_MS = 1000;
  private static readonly IDLE_MS = 3000;
  /** Shorter idle threshold for selector detection (UI is ready immediately). */
  private static readonly SELECTOR_IDLE_MS = 1500;
  /**
   * Grace period before the first tick processes output.
   * Prevents the raw PTY input echo from being captured before Claude Code
   * clears and re-renders its TUI (which happens within ~100-200 ms of
   * receiving the input, but we give a 1.5 s margin for loaded machines).
   */
  private static readonly WARMUP_MS = 1500;
  /** Max idle with no visible content (spinner only) before finalizing. */
  private static readonly EMPTY_TIMEOUT_MS = 60_000;
  private static readonly MAX_MS = 120_000;

  constructor(
    private readonly sessionId: string,
    private readonly pluginId: string,
    onSessionIdDetected?: (sessionId: string) => void,
    onRateLimitDetected?: (reset: string) => void,
    onTurnComplete?: () => void,
    onTerminalTurnDetected?: () => void,
    /**
     * Per-pairing token captured from `/api/pairing/status`. When present,
     * forwarded as `X-Plugin-Auth-Token` on every POST to
     * `/api/commands/output`. Undefined for sessions paired before this CLI
     * version (or against an older backend) — those keep working via the
     * server's rolling legacy fallback (sunset 2026-05-25).
     */
    private readonly pluginAuthToken?: string,
  ) {
    this.onSessionIdDetected = onSessionIdDetected;
    this.onRateLimitDetected = onRateLimitDetected;
    this.onTurnComplete = onTurnComplete;
    this.onTerminalTurnDetected = onTerminalTurnDetected;
  }

  /**
   * Called by the terminal-turn callback once the user message is known.
   * Sequences: clear → user_message (if any) → new_turn → start timer.
   * This guarantees the user message appears before the typing placeholder
   * in the apps, with no race against the clear event.
   */
  async startTerminalTurn(userText?: string): Promise<void> {
    this.terminalTurnPending = false;
    this.stopPoll();
    this.rawBuffer = '';
    this.lastSentContent = '';
    this.lastSentChromeStepsJson = '';
    this.chromeStepsHistory = [];
    this.lastPushTime = 0;
    this.active = true;
    this.startTime = Date.now();

    await this.postChunk({ clear: true });
    if (userText) {
      await this.postChunk({ type: 'user_message', content: userText, done: true });
    }
    await this.postChunk({ type: 'new_turn', content: '', done: false });

    this.pollTimer = setInterval(() => this.tick(), OutputService.POLL_MS);
  }

  newTurn(): void {
    this.stopPoll();
    this.rawBuffer = '';
    this.lastSentContent = '';
    this.lastSentChromeStepsJson = '';
    this.chromeStepsHistory = [];
    this.lastPushTime = 0;
    this.active = true;
    this.terminalTurnPending = false;
    this.startTime = Date.now();

    this.postChunk({ clear: true })
      .then(() => this.postChunk({ type: 'new_turn', content: '', done: false }))
      .catch(() => {});

    this.pollTimer = setInterval(() => this.tick(), OutputService.POLL_MS);
  }

  /**
   * Like newTurn() but signals clients that a session is being resumed.
   * The resumedSessionId tells clients to fetch the conversation from the API.
   * Awaits the POST so callers can guarantee the signal is sent before restarting Claude.
   */
  async newTurnResume(resumedSessionId: string): Promise<void> {
    this.stopPoll();
    this.rawBuffer = '';
    this.lastSentContent = '';
    this.lastSentChromeStepsJson = '';
    this.chromeStepsHistory = [];
    this.lastPushTime = 0;
    this.active = true;
    this.startTime = Date.now();

    await this.postChunk({ clear: true });
    await this.postChunk({ type: 'new_turn', resumedSessionId, content: '', done: false });

    this.pollTimer = setInterval(() => this.tick(), OutputService.POLL_MS);
  }

  push(raw: string): void {
    if (!this.active) {
      // Detect terminal-initiated turn: user typed directly in the terminal.
      // Only fire once per turn (terminalTurnPending guards duplicate triggers).
      if (!this.terminalTurnPending) {
        const printable = raw.replace(/\x1B\[[^@-~]*[@-~]/g, '').replace(/[\x00-\x1F\x7F]/g, '');
        if (printable.trim()) {
          this.terminalTurnPending = true;
          this.onTerminalTurnDetected?.();
        }
      }
      return;
    }
    this.rawBuffer += raw;
    const printable = raw.replace(/\x1B\[[^@-~]*[@-~]/g, '').replace(/[\x00-\x1F\x7F]/g, '');
    if (printable.trim()) {
      this.lastPushTime = Date.now();
      // Try to extract conversation ID from Claude output
      this.tryExtractSessionId(printable);
      // Detect rate limit messages
      this.tryDetectRateLimit(printable);
    }
  }

  /** Extract Claude conversation ID from output text (e.g., from /cost command or session resume) */
  private tryExtractSessionId(text: string): void {
    // Patterns to match session/conversation IDs in Claude output
    const patterns = [
      /Resuming session[:\s]+([a-f0-9-]{36})/i,
      /Session[:\s]+([a-f0-9-]{36})/i,
      /Conversation[:\s]+([a-f0-9-]{36})/i,
      /Session\s+ID[:\s]+([a-f0-9-]{36})/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && this.onSessionIdDetected) {
        this.onSessionIdDetected(match[1]);
        return;
      }
    }
  }

  /** Detect rate limit messages from Claude Code output (e.g. "You've hit your limit · resets Apr 16 at 1pm") */
  private tryDetectRateLimit(text: string): void {
    const match = text.match(/hit your limit.*resets\s+(.+?)(?:\s*\(|$)/i)
      ?? text.match(/rate.?limit.*resets\s+(.+?)(?:\s*\(|$)/i);
    if (match && this.onRateLimitDetected) {
      this.onRateLimitDetected(match[1].trim());
    }
  }

  dispose(): void {
    this.stopPoll();
    this.active = false;
  }

  private tick(): void {
    if (!this.active) return;

    const now = Date.now();
    const elapsed = now - this.startTime;

    if (elapsed >= OutputService.MAX_MS) { this.finalize(); return; }

    // Skip early ticks to let Claude Code process and re-render.
    // The raw PTY input echo arrives within ~1 ms of writing; Claude Code's
    // full TUI re-render (which clears the echo) follows within ~100 ms.
    // Waiting 1.5 s guarantees we see the settled state, not the raw echo.
    if (elapsed < OutputService.WARMUP_MS) return;

    const lines = renderToLines(this.rawBuffer);
    this.postChromeSteps(lines);
    const selector = detectSelector(lines) ?? detectListSelector(lines);

    if (selector) {
      const idleMs = this.lastPushTime > 0 ? now - this.lastPushTime : elapsed;
      if (idleMs >= OutputService.SELECTOR_IDLE_MS) {
        this.stopPoll();
        this.active = false;
        this.postChunk({ type: 'select_prompt', content: selector.question, options: selector.options, optionDescriptions: selector.optionDescriptions, currentIndex: selector.currentIndex, done: true }).catch(() => {});
      }
      // While selector is still settling, don't send anything
      return;
    }

    const content = filterChrome(lines).join('\n').replace(/\n{3,}/g, '\n\n').trim();

    if (!content) {
      if (elapsed >= OutputService.EMPTY_TIMEOUT_MS) this.finalize();
      return;
    }

    const idleMs = this.lastPushTime > 0 ? now - this.lastPushTime : elapsed;
    if (idleMs >= OutputService.IDLE_MS) { this.finalize(); return; }

    if (content !== this.lastSentContent) {
      this.lastSentContent = content;
      this.postChunk({ type: 'text', content, done: false }).catch(() => {});
    }
  }

  private finalize(): void {
    const lines = renderToLines(this.rawBuffer);
    this.postChromeSteps(lines);
    const selector = detectSelector(lines) ?? detectListSelector(lines);
    this.stopPoll();
    this.active = false;

    if (selector) {
      this.postChunk({ type: 'select_prompt', content: selector.question, options: selector.options, optionDescriptions: selector.optionDescriptions, currentIndex: selector.currentIndex, done: true }).catch(() => {});
    } else {
      const content = filterChrome(lines).join('\n').replace(/\n{3,}/g, '\n\n').trim();
      this.postChunk({ type: 'text', content, done: true }).catch(() => {});
      this.onTurnComplete?.();
    }
  }

  private stopPoll(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  private postChromeSteps(lines: string[]): void {
    const visible = lines
      .filter((l) => isChromeLine(l))
      .map((l) => parseChromeLine(l))
      .filter((s): s is ChromeStep => s !== null);
    if (visible.length === 0) return;

    // Accumulate unique steps (by tool+label) into the turn history.
    // The CLI sends the growing unique list; apps REPLACE rather than append.
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
    this.postChunk({ type: 'chrome_steps', content: '', steps: [...this.chromeStepsHistory] }).catch(() => {});
  }

  private postChunk(body: Record<string, unknown>): Promise<void> {
    // Critical chunks must reach the server: clear, new_turn, user_message, and any
    // done:true finalizer (text, select_prompt).  Streaming updates (text done:false,
    // chrome_steps) are superseded by the next tick, so no retry needed.
    const isCritical =
      body.clear === true ||
      body.type === 'new_turn' ||
      body.type === 'user_message' ||
      body.done === true;
    const maxRetries = isCritical ? 3 : 0;

    // Compute payload once — it's the same across all retry attempts.
    const payload = JSON.stringify({
      sessionId: this.sessionId,
      pluginId: this.pluginId,
      ...body,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    // Forward the per-pairing token when present. Sessions paired before
    // this field existed simply omit the header and rely on the server's
    // rolling legacy fallback (sunset 2026-05-25).
    if (this.pluginAuthToken) {
      headers['X-Plugin-Auth-Token'] = this.pluginAuthToken;
    }

    return new Promise((resolve) => {
      const attempt = (attemptsLeft: number) => {
        // Call through _transport so tests can vi.spyOn it.
        _transport.sendOutputChunk(`${API_BASE}/api/commands/output`, headers, payload)
          .then(({ statusCode, body: resBody }) => {
            if (statusCode >= 400) {
              process.stderr.write(`[codeam] output API error ${statusCode}: ${resBody}\n`);
            }
            resolve();
          })
          .catch(() => {
            if (attemptsLeft > 0) {
              const delay = 200 * (maxRetries - attemptsLeft + 1);
              setTimeout(() => attempt(attemptsLeft - 1), delay);
            } else {
              resolve();
            }
          });
      };

      attempt(maxRetries);
    });
  }
}

// Exported transport object — allows tests to spy on the HTTP send without
// trying to monkey-patch the built-in `http` module (whose exports are
// non-configurable). Mirrors the pattern used in pairing.service.ts.
export const _transport = {
  sendOutputChunk: _sendOutputChunk,
};

export function _sendOutputChunk(
  url: string,
  headers: Record<string, string>,
  payload: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const u = new URL(url);
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 8000,
      },
      (res) => {
        let resData = '';
        res.on('data', (c: Buffer) => { resData += c.toString(); });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({ statusCode: res.statusCode ?? 0, body: resData });
        });
      },
    );
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    req.on('timeout', () => { req.destroy(); });
    req.write(payload);
    req.end();
  });
}
