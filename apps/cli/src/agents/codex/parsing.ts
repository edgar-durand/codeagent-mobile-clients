import type { ChromeStep } from '@codeagent/shared';

/**
 * Codex-specific TUI chrome parsers.
 *
 * Codex's TUI conventions differ from Claude's in two key ways:
 *
 *   - User prompt echo: `›` (U+203A SINGLE RIGHT-POINTING ANGLE
 *     QUOTATION MARK) instead of Claude's `❯` / `>`.
 *   - Agent reply prefix: `•` (U+2022 BULLET) — the SAME glyph that
 *     Claude Code uses for tool-call bullets. Because the semantics
 *     are opposite (tool-call noise for Claude vs. actual reply for
 *     Codex), agent-specific parsing is non-negotiable.
 *
 * The shared `filterChrome` function cannot distinguish the two
 * because it was written for Claude's glyph conventions: it strips
 * `•`-prefixed lines that match known tool verbs (Read, Edit, Bash…)
 * and lets through everything else. For Codex this works in the
 * opposite direction — the agent's actual replies arrive with `•`
 * and need to be KEPT (with the prefix stripped), while Claude's
 * shared logic was inclined to drop or echo-continuation-swallow
 * them. Routing through the per-agent strategy eliminates the
 * ambiguity entirely.
 */

const BOX_DRAW_RE = /^[╭─╮│╰╯]/u;
// Codex user echo: `›` (U+203A). Also guard against plain `>`.
const CODEX_USER_ECHO_RE = /^[›>]\s+\S/u;
// Codex agent reply prefix. The TUI renders this with either `•`
// (U+2022 BULLET) or `·` (U+00B7 MIDDLE DOT) depending on the
// terminal font / Codex CLI version. Both glyphs accepted.
const CODEX_AGENT_REPLY_RE = /^[•·]\s/u;
const TIP_RE = /^\s*Tip:\s/i;
const LEARN_MORE_RE = /^\s*Learn more:\s/i;
// Codex bottom status footer — always rendered at the bottom of the
// TUI while a session is live. Examples:
//   "gpt-5.5 default · ~/Documents/codeagent"
//   "gpt-5.4-mini default · /tmp"
// Pattern: any non-space token + "default" + middle dot/bullet +
// a path-looking token. Anchored loosely so we tolerate the Codex
// CLI swapping the separator glyph or adding extra status fields.
const CODEX_STATUS_FOOTER_RE = /\bdefault\s+[·•]\s+\S+/i;

/**
 * Codex-specific chrome stripper.
 *
 * Drops:
 *   - Empty / ANSI-only lines
 *   - Intro box-drawing lines (╭─╮│╰╯) — the OpenAI Codex startup card
 *   - Banner content lines inside the box (OpenAI Codex header, model:,
 *     directory:)
 *   - Tip: / Learn more: banners printed after the startup box
 *   - User prompt echo (`› text`)
 *   - Any line while within the user-echo continuation block
 *
 * Keeps:
 *   - Agent replies (`• text`) — prefix stripped so the mobile bubble
 *     receives clean text
 *   - Everything else (multi-line agent responses that don't carry
 *     the `•` prefix on continuation lines)
 */
export function filterCodexChrome(lines: string[]): string[] {
  const out: string[] = [];
  let skipEchoContinuation = false;

  for (const line of lines) {
    const t = line.trimEnd();
    const trimmed = t.trimStart();

    // Skip empty / whitespace-only lines; reset echo guard.
    if (!trimmed) {
      skipEchoContinuation = false;
      continue;
    }

    // Drop intro box-drawing lines (Codex startup card frame).
    if (BOX_DRAW_RE.test(trimmed)) continue;

    // Drop the content lines inside the startup box.
    if (
      /^OpenAI Codex\b/i.test(trimmed) ||
      /^>_\s+OpenAI Codex\b/i.test(trimmed) ||
      /^model:\s/i.test(trimmed) ||
      /^directory:\s/i.test(trimmed)
    ) continue;

    // Drop Tip: / Learn more: post-startup banners.
    if (TIP_RE.test(t) || LEARN_MORE_RE.test(t)) continue;

    // Drop the bottom status footer ("gpt-5.5 default · ~/path") that
    // Codex re-renders on every frame. Without this rule the footer
    // leaks into the mobile feed as the only "agent content" once the
    // real reply has scrolled out of the visible PTY window.
    // CHECK BEFORE the agent-reply rule because the footer carries
    // a `·` and would otherwise look like a continuation of a `·`
    // reply on terminals where Codex uses U+00B7 for both.
    if (CODEX_STATUS_FOOTER_RE.test(trimmed)) {
      skipEchoContinuation = false;
      continue;
    }

    // Agent reply — `•` (U+2022) or `·` (U+00B7) prefix. Reset the
    // echo guard and emit the line WITHOUT the bullet so the mobile
    // bubble is clean.
    if (CODEX_AGENT_REPLY_RE.test(trimmed)) {
      skipEchoContinuation = false;
      // Strip the leading bullet + single space.
      out.push(t.replace(/^(\s*)[•·]\s/, '$1'));
      continue;
    }

    // User prompt echo — `›` (U+203A) or plain `>`. Set continuation
    // guard so separator / blank lines after the echo also get dropped.
    if (CODEX_USER_ECHO_RE.test(trimmed)) {
      skipEchoContinuation = true;
      continue;
    }

    // Anything else while in echo-continuation mode: drop.
    if (skipEchoContinuation) continue;

    // Default: keep the line as-is.
    out.push(t);
  }

  return out;
}

/**
 * Codex doesn't surface tool-call lines as conversational chrome the
 * way Claude does. Until a follow-up adds chromeSteps for Codex,
 * return null so the relay treats every non-filtered line as content
 * text rather than a progress indicator.
 */
export function parseCodexChrome(_line: string): ChromeStep | null {
  return null;
}

/**
 * Codex doesn't currently expose Claude-style numbered selectors via
 * the TUI. Slash commands like /model open a dedicated sub-screen that
 * can't be introspected by glyph alone. Return null until a concrete
 * selector pattern emerges from real Codex sessions.
 */
export function detectCodexSelector(_lines: string[]): null {
  return null;
}
