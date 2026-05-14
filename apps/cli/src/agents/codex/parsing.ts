import type { ChromeStep } from '@codeagent/shared';
import { log } from '../../services/logger';

/**
 * Codex-specific TUI chrome parsers.
 *
 * Codex's TUI layout (observed against codex v0.130.x + GPT-5.5):
 *
 *   ╭─────────────────────────╮
 *   │ >_ OpenAI Codex (v…)    │   ← startup card (filtered)
 *   │ model: gpt-5.5          │
 *   │ directory: ~/…          │
 *   ╰─────────────────────────╯
 *
 *     Tip: GPT-5.5 …                ← banner (filtered)
 *     Learn more: …                 ← banner (filtered)
 *
 *   ╭─────────────────────────╮
 *   │ hola                    │   ← user-input box (filtered via BOX_DRAW)
 *   ╰─────────────────────────╯
 *
 *   • Hola. ¿En qué estás …       ← AGENT REPLY (kept, bullet stripped)
 *
 *   ╭─────────────────────────╮
 *   │ › Implement {feature}   │   ← next input box (filtered via BOX_DRAW)
 *   ╰─────────────────────────╯
 *
 *   gpt-5.5 default · ~/…         ← bottom status footer (filtered)
 *
 * The codeam CLI banner ("· Edgar Durand · PRO", "· Launching Codex CLI…")
 * is printed by OUR CLI before Codex spawns. Those lines start with `·`
 * (U+00B7 MIDDLE DOT) and must be filtered explicitly so they don't get
 * mistaken for agent replies (which can also start with the same dot
 * depending on the Codex build).
 */

const BOX_DRAW_RE = /^[╭─╮│╰╯]/u;
// Bullet glyphs Codex (and codeam's own banner) use as line markers:
//   `•` U+2022 BULLET
//   `·` U+00B7 MIDDLE DOT
//   `‧` U+2027 HYPHENATION POINT
//   `∙` U+2219 BULLET OPERATOR
//   `⋅` U+22C5 DOT OPERATOR
// Defensive set — small visual size makes them indistinguishable in
// screenshots, and Codex has historically swapped between them across
// versions.
const BULLET_CHARS = '•·‧∙⋅';
const CODEX_AGENT_REPLY_RE = new RegExp(`^[${BULLET_CHARS}]\\s`, 'u');
const STRIP_BULLET_RE = new RegExp(`^(\\s*)[${BULLET_CHARS}]\\s`, 'u');
// Codex user echo (bare, not boxed): `›` (U+203A) or `>`.
const CODEX_USER_ECHO_RE = /^[›>]\s+\S/u;
const TIP_RE = /^\s*Tip:\s/i;
const LEARN_MORE_RE = /^\s*Learn more:\s/i;
// Codex bottom status footer — always rendered at the bottom of the
// TUI while a session is live. Examples:
//   "gpt-5.5 default · ~/Documents/codeagent"
//   "gpt-5.4-mini default · /tmp"
// "default" + bullet/dot + path-looking token.
const CODEX_STATUS_FOOTER_RE = /\bdefault\s+[·•]\s+\S+/i;
// codeam CLI banner lines (NOT codex output — printed by our own CLI
// before Codex spawns). Examples:
//   "· Edgar Durand · PRO"
//   "· Launching Codex CLI…"
//   "Paired!"
//   "✓ Paired with Edgar Durand (PRO)"
//   "codeam v2.12.4"
const CODEAM_BANNER_RES: RegExp[] = [
  // Bullet-prefixed banner entries (any role / launch label).
  new RegExp(`^[${BULLET_CHARS}]\\s+(Launching|Edgar|PRO|FREE|ENTERPRISE)\\b`, 'i'),
  /^Paired\b/,
  /^codeam\b\s+v\d/,
  /^✓\s+Paired/,
  /^◇\s+Paired/,
];

/**
 * Codex-specific chrome stripper.
 *
 * Whitelist-light approach: aggressively drop lines we KNOW are chrome
 * (boxes, banners, status footer, codeam's own startup output), strip
 * the leading bullet off agent-reply lines, and KEEP everything else.
 *
 * The prior version used a `skipEchoContinuation` state machine that
 * dropped the first non-echo line after a `› user_text` echo. That
 * worked when Codex emitted bare user echoes, but the current Codex
 * TUI wraps user input in a box (filtered via BOX_DRAW_RE), so the
 * state machine was both unnecessary and risky — if the bullet glyph
 * didn't exactly match the regex, the agent reply fell into the
 * "skip continuation" branch and got silently dropped. Removed.
 */
export function filterCodexChrome(lines: string[]): string[] {
  const out: string[] = [];

  for (const line of lines) {
    const t = line.trimEnd();
    const trimmed = t.trimStart();

    if (!trimmed) continue;

    // Drop box-drawing lines (Codex startup card frame + user-input
    // box edges + bottom borders).
    if (BOX_DRAW_RE.test(trimmed)) continue;

    // Drop startup-card content lines.
    if (
      /^OpenAI Codex\b/i.test(trimmed) ||
      /^>_\s+OpenAI Codex\b/i.test(trimmed) ||
      /^model:\s/i.test(trimmed) ||
      /^directory:\s/i.test(trimmed)
    ) continue;

    // Drop Tip: / Learn more: post-startup banners.
    if (TIP_RE.test(t) || LEARN_MORE_RE.test(t)) continue;

    // Drop the bottom status footer.
    if (CODEX_STATUS_FOOTER_RE.test(trimmed)) continue;

    // Drop codeam's own CLI banner lines (not codex output).
    if (CODEAM_BANNER_RES.some(re => re.test(trimmed))) continue;

    // Drop bare user-echo lines (`› hola`, `> hola`) — defensive in
    // case Codex emits unboxed echoes on some terminals.
    if (CODEX_USER_ECHO_RE.test(trimmed)) continue;

    // Agent reply: strip the leading bullet so the mobile bubble is
    // clean, then keep.
    if (CODEX_AGENT_REPLY_RE.test(trimmed)) {
      out.push(t.replace(STRIP_BULLET_RE, '$1'));
      continue;
    }

    // Default: keep the line as-is. Multi-line agent replies whose
    // continuation lines carry no bullet land here.
    out.push(t);
  }

  log.trace('codex-parse', `filterCodexChrome in=${lines.length} out=${out.length}`);
  // Verbose breadcrumb that includes a sample of input + output so
  // future-Edgar can diagnose without re-running with a custom build.
  // Only fires when CODEAM_DEBUG=1 — production runs are silent.
  if (process.env.CODEAM_DEBUG === '1') {
    const sampleIn = lines.slice(-40).map((l, i) => `  in[${i}] ${JSON.stringify(l)}`).join('\n');
    const sampleOut = out.map((l, i) => `  out[${i}] ${JSON.stringify(l)}`).join('\n');
    log.debug('codex-parse', `\n${sampleIn}\n---\n${sampleOut}`);
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
