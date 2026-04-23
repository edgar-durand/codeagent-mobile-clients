import * as https from 'https';
import * as http from 'http';
import { isChromeLine, parseChromeLine } from './parseChrome';
import type { ChromeStep } from './parseChrome';

const API_BASE = process.env.CODEAM_API_URL ?? 'https://codeagent-mobile-api.vercel.app';

// ─── Virtual Terminal ─────────────────────────────────────────────────────────

/**
 * Render raw PTY bytes into an array of screen lines using a simplified
 * virtual terminal.  Handles cursor movements (A/B/C/D/G/H), erase (J/K),
 * alternate-screen (?1049h), carriage return, and LF.
 */
function renderToLines(raw: string): string[] {
  const screen: string[] = [''];
  let row = 0;
  let col = 0;

  function ensureRow(): void {
    while (screen.length <= row) screen.push('');
  }

  function writeChar(ch: string): void {
    ensureRow();
    if (col < screen[row].length) {
      screen[row] = screen[row].slice(0, col) + ch + screen[row].slice(col + 1);
    } else {
      while (screen[row].length < col) screen[row] += ' ';
      screen[row] += ch;
    }
    col++;
  }

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];

    if (ch === '\x1B') {
      i++;
      if (i >= raw.length) break;

      if (raw[i] === '[') {
        i++;
        let param = '';
        while (i < raw.length && !/[@-~]/.test(raw[i])) param += raw[i++];
        const cmd = raw[i] ?? '';
        const n = parseInt(param) || 1;

        if      (cmd === 'A') { row = Math.max(0, row - n); }
        else if (cmd === 'B') { row += n; ensureRow(); }
        else if (cmd === 'C') { col += n; }
        else if (cmd === 'D') { col = Math.max(0, col - n); }
        else if (cmd === 'G') { col = Math.max(0, n - 1); }
        else if (cmd === 'H' || cmd === 'f') {
          const p = param.split(';');
          row = Math.max(0, (parseInt(p[0] ?? '1') || 1) - 1);
          col = Math.max(0, (parseInt(p[1] ?? '1') || 1) - 1);
          ensureRow();
        } else if (cmd === 'J') {
          if (param === '2' || param === '3') {
            screen.length = 1; screen[0] = ''; row = 0; col = 0;
          } else if (param === '1') {
            for (let r = 0; r < row; r++) screen[r] = '';
            screen[row] = ' '.repeat(col) + screen[row].slice(col);
          } else {
            screen[row] = screen[row].slice(0, col);
            screen.splice(row + 1);
          }
        } else if (cmd === 'K') {
          ensureRow();
          if      (param === '' || param === '0') screen[row] = screen[row].slice(0, col);
          else if (param === '1') screen[row] = ' '.repeat(col) + screen[row].slice(col);
          else if (param === '2') screen[row] = '';
        } else if (cmd === 'h' && (param === '?1049' || param === '?47')) {
          screen.length = 1; screen[0] = ''; row = 0; col = 0;
        } else if (cmd === 'l' && (param === '?1049' || param === '?47')) {
          screen.length = 1; screen[0] = ''; row = 0; col = 0;
        }
      } else if (raw[i] === ']') {
        i++;
        while (i < raw.length) {
          if (raw[i] === '\x07') break;
          if (raw[i] === '\x1B' && i + 1 < raw.length && raw[i + 1] === '\\') { i++; break; }
          i++;
        }
      }
    } else if (ch === '\r') {
      if (i + 1 < raw.length && raw[i + 1] === '\n') {
        row++; col = 0; ensureRow(); i++;
      } else {
        col = 0; // CR alone: overwrite current line from start
      }
    } else if (ch === '\n') {
      row++; col = 0; ensureRow();
    } else if (ch >= ' ' || ch === '\t') {
      writeChar(ch);
    }

    i++;
  }

  return screen;
}

// ─── Selector Detection ───────────────────────────────────────────────────────

interface SelectPrompt {
  question: string;
  options: string[];
  optionDescriptions: string[];
  /** 0-based index of the highlighted item (always 0 for numbered selectors). */
  currentIndex: number;
}

/**
 * Detect whether the rendered terminal lines contain an interactive selector.
 *
 * Operates on the OUTPUT of renderToLines() — clean, already-rendered text with
 * no ANSI codes — rather than on raw PTY bytes.  renderToLines() correctly
 * handles all cursor movements and overwrites, so by the time we get here the
 * screen is a reliable source of truth.
 *
 * React Ink renders the highlight marker by overwriting col 0: "  1. Label\r❯"
 * which renderToLines collapses into "❯ 1. Label" on one screen line.
 *
 * Detection: ❯ must be on the SAME line as a numbered option (e.g. "❯ 1. Label"),
 * not merely somewhere in the screen. This prevents false positives when Claude's
 * own response contains a numbered list while the input cursor (❯) appears elsewhere.
 *
 * Secondary guard: if the normal idle input prompt ("? for shortcuts") is visible,
 * Claude Code is in regular input-ready state — no interactive selector is active.
 * When a real selector is displayed, the input field disappears entirely.
 */
function detectSelector(lines: string[]): SelectPrompt | null {
  // If the idle input hint is visible, the normal input field is active — no selector.
  if (lines.some(l => /\?\s+for\s+shortcuts/i.test(l.trim()))) return null;

  // Strip box-border chars (│ ╭ ╰ ╮ ╯ and similar) from line edges so that
  // numbered selectors rendered inside a bordered panel (e.g. /mcp server
  // detail view: "│ ❯ 1. Authenticate │") are still detected correctly.
  const clean = lines.map(l =>
    l
      .replace(/^[│╭╰╮╯┌└┐┘├┤┬┴┼]\s?/, '')    // strip leading border char
      .replace(/\s*[│╭╰╮╯┌└┐┘├┤┬┴┼─━═]+\s*$/, '') // strip trailing fill + border
  );

  // ❯ must be directly in front of a numbered option on the same (cleaned) line.
  if (!clean.some(l => /^❯\s*\d+\./.test(l.trim()))) return null;

  // Find the index of the first option line.
  let optionStartIdx = -1;
  for (let i = 0; i < clean.length; i++) {
    if (/^(?:❯\s*)?\d+\.\s/.test(clean[i].trim())) { optionStartIdx = i; break; }
  }
  if (optionStartIdx === -1) return null;

  // Question: join all meaningful cleaned lines that appear before the first option.
  const questionParts: string[] = [];
  for (let i = 0; i < optionStartIdx; i++) {
    const t = clean[i].trim();
    if (!t) continue;
    if (/^[─━—═\-]{3,}$/.test(t)) continue;   // separator lines
    if (/^\[.*\]$/.test(t)) continue;           // badge labels like [Siguiente paso]
    if (/^[>❯]\s/.test(t)) continue;            // user echo lines
    // Skip lines that look like PTY overwrite artifacts — no spaces and long
    // (e.g. "needsvauthenticationhentication" from a mid-transition render frame)
    if (!t.includes(' ') && t.length > 15) continue;
    questionParts.push(t);
  }
  // Remove lines that are pure substrings of other question lines (overwrite artifacts)
  const question = questionParts
    .filter((line, i, arr) => !arr.some((other, j) => j !== i && other.includes(line)))
    .join('\n')
    .trim();

  // Parse options and their descriptions from cleaned lines.
  const optionLabels = new Map<number, string>();
  const optionDescs = new Map<number, string[]>();
  let currentNum = -1;

  for (let i = optionStartIdx; i < clean.length; i++) {
    const t = clean[i].trim();
    if (!t) continue;

    // Match "❯ 1. Label" or "  2. Label"
    const m = t.match(/^(?:❯\s*)?(\d+)\.\s+(.+)/);
    if (m) {
      const num = parseInt(m[1], 10);
      if (!optionLabels.has(num)) {
        optionLabels.set(num, m[2].trim());
        optionDescs.set(num, []);
      }
      currentNum = num;
    } else if (
      currentNum !== -1 &&
      !/^Enter to/i.test(t) &&
      !/^[─━—═\-]{3,}$/.test(t) &&
      !/↑.*↓.*navigate/i.test(t) &&
      !/Esc to/i.test(t)
    ) {
      // Indented description line belonging to the current option.
      optionDescs.get(currentNum)?.push(t);
    }
  }

  // Require ≥2 sequential options starting from 1
  const keys = [...optionLabels.keys()].sort((a, b) => a - b);
  if (keys.length < 2 || keys[0] !== 1) return null;

  return {
    question,
    options: keys.map(k => optionLabels.get(k)!),
    optionDescriptions: keys.map(k => (optionDescs.get(k) ?? []).join(' ').trim()),
    currentIndex: 0,
  };
}

/**
 * Detect list-style interactive selectors (e.g. `/mcp`, `/model`).
 *
 * These render differently from numbered selectors:
 *   - The selected item is prefixed with "  ❯ " (2 spaces + ❯ + space)
 *   - Unselected items are indented with 4 spaces: "    label"
 *   - A navigation hint "↑↓ to navigate · Enter to confirm · Esc to cancel"
 *     appears at the bottom
 *   - There is NO numbered option format ("❯ 1. Label")
 *
 * Returns `currentIndex` (0-based position of ❯) so the client can send
 * bidirectional arrow navigation rather than always starting from index 0.
 */
function detectListSelector(lines: string[]): SelectPrompt | null {
  // Must have ↑/↓ navigation hint — distinguishes list-style from plain output.
  if (!lines.some(l => /[↑↓].*navigate/i.test(l.trim()))) return null;

  // Avoid double-detection with numbered selector (❯ followed by a digit).
  if (lines.some(l => /^❯\s*\d+\./.test(l.trim()))) return null;

  // Must have at least one selected-item marker: leading whitespace + ❯ + space.
  if (!lines.some(l => /^\s+❯\s+\S/.test(l))) return null;

  // Item line predicates (operate on the raw, untrimmed line).
  const isSelected   = (line: string) => /^\s+❯\s+\S/.test(line);
  const isUnselected = (line: string) => /^    \S/.test(line);
  const isItem       = (line: string) => isSelected(line) || isUnselected(line);

  // Find where options start.
  let optionStartIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isItem(lines[i])) { optionStartIdx = i; break; }
  }
  if (optionStartIdx === -1) return null;

  // Question: meaningful lines before the first option (strip box-drawing chars).
  const questionParts: string[] = [];
  for (let i = 0; i < optionStartIdx; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/^[─━—═\-]{3,}$/.test(t)) continue;       // separator lines
    if (/[┌└│┐┘├┤┬┴┼]/.test(t)) {                 // box-drawing lines
      const inner = t.replace(/[│┌└┐┘├┤┬┴┼─]/g, '').trim();
      if (inner) questionParts.push(inner);
      continue;
    }
    if (/^[>❯]\s/.test(t)) continue;               // user echo
    if (/[↑↓].*navigate/i.test(t)) continue;
    if (!t.includes(' ') && t.length > 15) continue; // likely PTY artifact
    questionParts.push(t);
  }
  const question = questionParts
    .filter((line, i, arr) => !arr.some((other, j) => j !== i && other.includes(line)))
    .join('\n')
    .trim();

  // Parse options; track which is currently highlighted.
  const options: string[] = [];
  let currentIndex = 0;

  for (const line of lines.slice(optionStartIdx)) {
    const t = line.trim();
    if (!t) continue;
    if (/[↑↓].*navigate/i.test(t)) break;          // nav hint = end of list
    if (/^[─━—═\-]{3,}$/.test(t)) continue;        // separator

    if (isSelected(line)) {
      currentIndex = options.length;
      options.push(t.replace(/^❯\s+/, '').trim());
    } else if (isUnselected(line)) {
      options.push(t);
    }
  }

  if (options.length < 2) return null;

  return {
    question,
    options,
    optionDescriptions: options.map(() => ''),
    currentIndex,
  };
}

// ─── Chrome Filter ────────────────────────────────────────────────────────────

/** Remove TUI chrome: separators, spinners, status bar, prompts, thinking frames.
 *
 * Stateful pass so that continuation lines of a user-input echo (lines that
 * follow a `> text` or `❯ text` line without the leading marker) are also
 * removed.  The flag resets on any empty line or separator line, which always
 * appears between the user echo and Claude's response in the TUI.
 */
export function filterChrome(lines: string[]): string[] {
  const result: string[] = [];
  let skipEchoContinuation = false;

  for (const line of lines) {
    const t = line.trim();

    // Empty lines reset continuation tracking and are always dropped.
    if (!t) { skipEchoContinuation = false; continue; }

    // Hard structural markers — always drop and reset continuation.
    if (/^[─━—═─\-]{3,}$/.test(t)) { skipEchoContinuation = false; continue; }

    // Spinner / progress chars, interrupt hint, effort badge — always drop.
    if (/^[✳✢✶✻✽✴✷✸✹⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓▁▂▃▄▅▆▇█]\s/.test(t)) continue;
    if (/esc.{0,5}to.{0,5}interrupt/i.test(t)) continue;
    if (/high\s*[·•]\s*\/effort/i.test(t)) continue;

    // Bare cursor / thinking / shortcut / limit notices — always drop.
    if (/^[❯>]\s*$/.test(t)) continue;
    if (/^\(thinking\)\s*$/.test(t)) continue;
    if (/^\?\s.*shortcut/i.test(t)) continue;
    if (/spending limit|usage limit/i.test(t) && t.length < 80) continue;
    if (/↑\s*\/?\s*↓\s*to\s*navigate/i.test(t)) continue;

    // TUI fragment ghosts — a single visible character is never real content
    // (e.g. "E" or "9" from a status-bar column, lone "|" cursor artifact).
    if (t.replace(/\s/g, '').length === 1) continue;

    // Progress / status bar lines that use box-drawing dashes as filler
    // (e.g. "─Searching─for─2─patterns…─(ctrl+o to expand)─────────────").
    // Six or more '─' chars on one line is always TUI chrome, never content.
    if ((t.match(/─/g)?.length ?? 0) >= 6) continue;

    // Claude Code's inline expand hint — appears in search/tool result bars.
    if (/ctrl\+?o\s+to\s+expand/i.test(t)) continue;

    // New Claude Code TUI format (v4+): bullet-prefixed tool-use lines.
    // Only filter lines whose verb matches a known tool — avoids clobbering bullet
    // points in Claude's actual text responses.
    if (
      /^•\s+(?:Read(?:ing)?|Edit(?:ing)?|Writ(?:e|ing)|Bash|Runn(?:ing)?|Search(?:ing)?|Glob(?:bing)?|Grep(?:ping)?|Creat(?:e|ing)|Execut(?:e|ing)|Task|Agent|NotebookEdit)\b/i.test(
        t,
      )
    )
      continue;

    // Tree connector lines (└) — always sub-items of TUI tool/status rows, never content.
    if (/^└\s/.test(t)) continue;

    // Status/thinking lines: "+ Puttering… (22s · ↑ 102 tokens)" or "+ Manifesting… (thinking)"
    if (/^\+\s/.test(t) && /\d+\s*s\s*[·•]|\bthought\s+for\b|\d+\s*tokens|\(thinking\)/i.test(t)) continue;

    // Context compaction notice: "↓ 518 tokens" or "↓ 518 tokens · thought for 18s"
    // Extended thinking indicator: "thought for 18s" (standalone or combined with compaction)
    if (/^↓\s*\d+\s*tokens/i.test(t)) continue;
    if (/^\bthought\s+for\s+\d+/i.test(t)) continue;

    // User input echo: `> text` or `❯ text` (but not option lines like `❯ 1.`).
    // Also catches box-bordered variants: `│ ❯ text` or `│ > text` where
    // Claude Code wraps the input field in a box (strip leading border char first).
    // Also marks subsequent lines as continuations to filter.
    const stripped = t.replace(/^[│╭╰╮╯┌└┐┘├┤┬┴┼]\s?/, '');
    if (/^[❯>]\s+\S/.test(stripped) && !/^[❯>]\s*\d+\./.test(stripped)) {
      skipEchoContinuation = true;
      continue;
    }

    // Continuation lines of the user input echo (e.g. wrapped second line
    // of a long prompt shown in Claude's conversation history area).
    if (skipEchoContinuation) continue;

    result.push(line);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────

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

    return new Promise((resolve) => {
      const attempt = (attemptsLeft: number) => {
        let settled = false;

        const u = new URL(`${API_BASE}/api/commands/output`);
        const transport = u.protocol === 'https:' ? https : http;
        const req = transport.request(
          {
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
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
              if (res.statusCode && res.statusCode >= 400) {
                process.stderr.write(`[codeam] output API error ${res.statusCode}: ${resData}\n`);
              }
              resolve();
            });
          },
        );

        req.on('error', () => {
          if (settled) return;
          settled = true;
          if (attemptsLeft > 0) {
            // Linear back-off: 200 ms, 400 ms, 600 ms between attempts.
            const delay = 200 * (maxRetries - attemptsLeft + 1);
            setTimeout(() => attempt(attemptsLeft - 1), delay);
          } else {
            resolve();
          }
        });

        // Timeout: destroy the socket — the error handler above will fire and
        // either schedule a retry or resolve.
        req.on('timeout', () => { req.destroy(); });
        req.write(payload);
        req.end();
      };

      attempt(maxRetries);
    });
  }
}
