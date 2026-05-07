/**
 * Raw PTY byte accumulator + terminal-input detection.
 *
 * Owns the bytes Claude's TUI emits. Bytes only accumulate while
 * the buffer is "active" (i.e. inside a turn). When the buffer is
 * inactive and printable bytes arrive, that's a terminal-initiated
 * turn — the user typed directly in their local terminal — and the
 * caller is told via the `terminalInputDetected` flag so it can
 * kick the turn lifecycle.
 *
 * Pure data-plane; no HTTP, no rendering, no parsing.
 */
export class PtyBuffer {
  private raw = '';
  private active = false;
  private lastPushAt = 0;
  private terminalInputPending = false;

  /** Whether to absorb pushes (`true`) or only watch for terminal input (`false`). */
  get isActive(): boolean { return this.active }

  /** Bytes accumulated since the last reset. */
  get content(): string { return this.raw }

  /** Wall-clock of the most recent printable push (`0` if none yet this turn). */
  get lastPushTime(): number { return this.lastPushAt }

  /** Length of the accumulated buffer in raw bytes (debug + tests). */
  get size(): number { return this.raw.length }

  activate(): void {
    this.active = true;
    this.raw = '';
    this.lastPushAt = 0;
    this.terminalInputPending = false;
  }

  deactivate(): void {
    this.active = false;
  }

  reset(): void {
    this.raw = '';
    this.lastPushAt = 0;
  }

  /**
   * Ingest a raw PTY frame. Returns whether the buffer was active
   * at the time (caller cares because rendering only matters for
   * active frames) and whether this push triggered the
   * terminal-initiated-turn signal.
   */
  push(raw: string): { active: boolean; terminalInputDetected: boolean } {
    if (!this.active) {
      let terminalInputDetected = false;
      if (!this.terminalInputPending && hasPrintable(raw)) {
        this.terminalInputPending = true;
        terminalInputDetected = true;
      }
      return { active: false, terminalInputDetected };
    }
    this.raw += raw;
    if (hasPrintable(raw)) this.lastPushAt = Date.now();
    return { active: true, terminalInputDetected: false };
  }
}

/**
 * Cheap "is there printable content here?" check. Strips ANSI CSI
 * sequences and control bytes before checking; matches the same
 * predicate the legacy single-class `OutputService.push()` used.
 */
export function hasPrintable(raw: string): boolean {
  const stripped = raw.replace(/\x1B\[[^@-~]*[@-~]/g, '').replace(/[\x00-\x1F\x7F]/g, '');
  return stripped.trim().length > 0;
}
