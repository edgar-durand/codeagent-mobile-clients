/**
 * TUI-chrome leak detector for the ACP text stream.
 *
 * claude runs headless over ACP; its `agent_message_chunk` text is ASSUMED to be
 * pure assistant prose. The 2026-07-16 incident proved that a drifting Claude
 * Code binary (v2.1.211) will stream its terminal UI chrome — the "What's new"
 * changelog banner, the `manual mode on · ? for shortcuts` status line,
 * box-drawing diff borders, and text permission dialogs — INTO that channel,
 * where mobile paints it as a garbled chat.
 *
 * This detector scans a captured ACP text stream for those chrome signatures. It
 * is the shared assertion behind:
 *   - the version-freeze contract guard (unit), and
 *   - the scheduled `acp-chrome-canary` (spawns a real claude ACP turn and fails
 *     if any chrome leaks), so a NEW Claude Code / adapter version that
 *     re-introduces the leak is caught before users see it.
 *
 * It is intentionally conservative — every pattern is chrome that never appears
 * in legitimate assistant prose — so it will not false-positive on real answers.
 */

export interface ChromeLeakHit {
  /** Stable id for the kind of chrome that leaked (for telemetry grouping). */
  marker: string;
  /** The offending line (trimmed), for the failure message. */
  line: string;
}

/** Box-drawing / heavy separator glyphs a TUI uses for borders + rules. */
const BOX_DRAWING = /[─-╿▀-▟]/; // ─ │ ┌ ╭ █ ▲ etc.

/**
 * Chrome line signatures. Each entry: [marker id, test]. The `test` gets a
 * single trimmed line. Keep every pattern specific to Claude Code chrome.
 */
const LINE_SIGNATURES: Array<[string, (line: string) => boolean]> = [
  ['whats_new_banner', (l) => /^what's new\b/i.test(l) || /welcome back!/i.test(l)],
  ['version_banner', (l) => /^claude code v\d+\.\d+\.\d+/i.test(l)],
  ['status_line', (l) => /manual mode on|\? for shortcuts|← for agents|for shortcuts ·/i.test(l)],
  ['permission_footer', (l) => /esc to cancel|tab to amend|shift\+tab/i.test(l)],
  // A line that is ENTIRELY box-drawing / separator glyphs (the empty-rule rows).
  ['box_drawing_rule', (l) => l.length > 0 && BOX_DRAWING.test(l) && /^[\s─-▟│─╭╮╰╯├┤┬┴┼]+$/.test(l)],
];

/**
 * Scan captured ACP text for leaked Claude Code TUI chrome. Returns one hit per
 * offending line (empty array = clean). `text` is the concatenation of every
 * `agent_message_chunk` delta for a turn.
 */
export function detectTuiChromeLeak(text: string): ChromeLeakHit[] {
  const hits: ChromeLeakHit[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    for (const [marker, test] of LINE_SIGNATURES) {
      if (test(line)) {
        hits.push({ marker, line: line.slice(0, 120) });
        break; // one marker per line is enough
      }
    }
  }
  return hits;
}

/** Convenience boolean for guards/canaries. */
export function hasTuiChromeLeak(text: string): boolean {
  return detectTuiChromeLeak(text).length > 0;
}
