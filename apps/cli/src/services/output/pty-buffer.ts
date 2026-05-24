/**
 * Hard cap on the raw byte accumulator. Above this we drop bytes
 * from the HEAD of the buffer (older frames) so the most recent
 * window stays intact — renderToLines is line-anchored, so as long
 * as the tail contains the current screen frame, dropping older
 * scroll-history bytes is safe. Without this cap a multi-MB tool
 * dump inside a single turn (Codex piping a large file, Claude
 * spitting a verbose stack trace) made `this.raw` grow linearly
 * until the CLI process OOM-killed. Audit anchor: R2.
 */
const MAX_RAW_BYTES = 2 * 1024 * 1024;
/**
 * When the cap fires, keep this many bytes so renderToLines still
 * sees a reasonable amount of scrollback. The 1.5MB / 2MB ratio
 * means a steady-state firehose only re-truncates every ~512KB of
 * new input — amortising the substring cost.
 */
const TAIL_KEEP_BYTES = 1.5 * 1024 * 1024;

/**
 * Raw PTY byte accumulator + terminal-input detection.
 *
 * Always accumulates. The `active` flag is just a hint to the
 * orchestrator about whether `tick()` should be processing the
 * buffer right now — it does NOT gate ingestion. Dropping bytes
 * while inactive made the cold-pair startup window lose Claude's
 * first interactive selector (the trust dialog), because by the
 * time the orchestrator finished its warmup the framing data was
 * already flushed past us and Claude was sitting idle.
 *
 * `activate()` flips the flag without resetting `raw`, so anything
 * Claude emitted between process spawn and the first turn boundary
 * is still in the buffer for the next render-and-detect tick.
 * `deactivate()` clears the buffer so a fresh between-turn idle
 * period starts empty (no stale cursor blink frames bleeding into
 * the next turn).
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
    this.lastPushAt = 0;
    this.terminalInputPending = false;
    // NOTE: do NOT reset `raw` here. Bytes Claude emitted before
    // the orchestrator armed (banner, trust dialog, …) need to be
    // visible to the next render so the selector detector can
    // surface them as a `select_prompt` chunk to the client.
  }

  deactivate(): void {
    this.active = false;
    // Done with this turn — drop the raw frame so the next
    // between-turn idle period and the next turn both start clean.
    this.raw = '';
    this.lastPushAt = 0;
  }

  reset(): void {
    this.raw = '';
    this.lastPushAt = 0;
  }

  /**
   * Ingest a raw PTY frame. Always accumulates so cold-startup
   * frames aren't lost. Returns whether the buffer was active at
   * the time (caller may render now, vs. wait) and whether this
   * push triggered the terminal-initiated-turn signal — the latter
   * still only fires while inactive, so the orchestrator can kick
   * a turn for human local-terminal typing.
   */
  push(raw: string): { active: boolean; terminalInputDetected: boolean } {
    this.raw += raw;
    // Cap the accumulator at MAX_RAW_BYTES (#57). Truncate from the
    // head — renderToLines is line-anchored and only the tail
    // (current screen frame) matters for downstream parsing.
    if (this.raw.length > MAX_RAW_BYTES) {
      this.raw = this.raw.slice(this.raw.length - TAIL_KEEP_BYTES);
    }
    if (hasPrintable(raw)) this.lastPushAt = Date.now();
    if (!this.active) {
      let terminalInputDetected = false;
      if (!this.terminalInputPending && hasPrintable(raw)) {
        this.terminalInputPending = true;
        terminalInputDetected = true;
      }
      return { active: false, terminalInputDetected };
    }
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
