import {
  isChromeLine,
  parseChromeLine,
  type ChromeStep,
} from '@codeagent/shared';

/**
 * Per-turn cumulative + delta tracker for chrome_steps.
 *
 * Claude's TUI re-emits the same thinking step on every render
 * tick during a long tool call (e.g. `Read(file.ts)` shows for
 * the entire duration of a Read). We dedup by `tool::label` so
 * the cumulative `history` only grows when something genuinely
 * new appears.
 *
 * `consumeDelta()` returns the steps NOT YET shipped on the
 * wire, so the CLI's transport sends only the delta — clients
 * accumulate, the wire is bounded by the count of unique steps
 * (not ticks × steps).
 */
export class ChromeStepTracker {
  private history: ChromeStep[] = [];
  private sentCount = 0;

  reset(): void {
    this.history = [];
    this.sentCount = 0;
  }

  /** Parse the rendered lines, append unseen steps to the cumulative history. */
  ingest(lines: string[]): void {
    const visible = lines
      .filter((l) => isChromeLine(l))
      .map((l) => parseChromeLine(l))
      .filter((s): s is ChromeStep => s !== null);
    if (visible.length === 0) return;

    for (const step of visible) {
      const exists = this.history.some(
        (s) => s.tool === step.tool && s.label === step.label,
      );
      if (!exists) this.history.push(step);
    }
  }

  /**
   * Returns the steps that have NOT yet been shipped on the wire,
   * marking them as shipped. Empty array means nothing new since
   * the last call. Caller forwards this as the chunk's
   * `appendSteps` payload.
   */
  consumeDelta(): ChromeStep[] {
    if (this.history.length === this.sentCount) return [];
    const delta = this.history.slice(this.sentCount);
    this.sentCount = this.history.length;
    return delta;
  }

  /** Snapshot of the cumulative unique-step history (debug + tests). */
  get cumulativeHistory(): readonly ChromeStep[] {
    return this.history;
  }
}
