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

  // Post-pass: wrap Codex-emitted code blocks in Markdown ``` fences.
  // Codex's TUI does syntax-highlighted code with no explicit fence
  // markers — just an indented run of code-shaped lines. The mobile /
  // web feed renders fenced code blocks with a copy button + monospace
  // styling via the backend's codeBlockParser; without fences, the
  // body comes through as a plain TextBlock and the user gets a
  // wall of unformatted text. Injecting fences here is Codex-only:
  // Claude (which emits proper ```lang fences itself) goes through
  // its own filter and is unaffected.
  const wrapped = wrapCodexCodeBlocks(out);

  // Info-level dump every time the filter runs so the always-on file
  // log captures EXACTLY what the parser saw on each tick. Critical
  // for the multi-line-reply bug class (e.g. bullet lists where the
  // first line lands in the chunk but continuation lines silently
  // disappear) — without this we'd have to ask the user to re-run
  // with CODEAM_DEBUG=1 and hope the heisenbug repros.
  //
  // Only dumps when there's something interesting:
  //   - non-empty output  (something was kept), OR
  //   - in.length >= 3 with the first non-empty in[] line containing
  //     letters (proves Codex emitted real content this tick).
  // Plain spinner / empty-screen ticks are skipped to keep noise low.
  const hasRealInput = lines.some(l => /\w/.test(l));
  if (out.length > 0 || hasRealInput) {
    const sampleIn = lines.slice(-50).map((l, i) => `  in[${i}] ${JSON.stringify(l)}`).join('\n');
    const sampleOut = out.map((l, i) => `  out[${i}] ${JSON.stringify(l)}`).join('\n');
    log.info('codex-parse', `in=${lines.length} out=${out.length}\n${sampleIn}\n---\n${sampleOut}`);
  } else {
    log.trace('codex-parse', `filterCodexChrome in=${lines.length} out=${out.length}`);
  }

  return wrapped;
}

// ─── Code-block detection ─────────────────────────────────────────

/**
 * Lines with at least one of these chars are "code-shaped". They're
 * the signal we use to detect runs of Codex-emitted code in a stream
 * of agent text. Tuned empirically against the captured Codex fixture
 * (Java, TypeScript, table headers, bullet lists) — `;`, `{`, `}`,
 * arrow `=>`, plus `=` are common in code and rare in prose. Bullet
 * lists ("• Plataforma...") and table headers ("| Col |") don't get
 * matched because they don't carry these characters in their bodies.
 */
const CODE_CHAR_RE = /[;{}]|=>|^\s*(?:import|public|private|static|class|function|interface|type|const|let|var|def|return|if|else|for|while)\b/;

/**
 * Heuristic language inference from the first ~10 lines of a code
 * block. Returns the best-guess Markdown language tag or '' (no tag,
 * still renders as code).
 */
function inferLanguage(block: string[]): string {
  const head = block.slice(0, 10).join('\n');
  if (/\bpublic\s+(?:static\s+)?(?:class|void|int|String)\b|System\.out\.println|\bjava\.util/.test(head)) return 'java';
  if (/\b(?:interface|type)\s+\w+\s*=?\s*[{<]|\bas\s+(?:string|number|boolean)\b|\b(?:string|number|boolean)\s*[;,)\]]/.test(head)) return 'typescript';
  if (/\bimport\s+\w+\s+from\s+['"]|=>\s*[{(]|\bconst\s+\w+\s*=\s*(?:async\s+)?\(/.test(head)) return 'javascript';
  if (/^\s*def\s+\w+\(|^\s*from\s+\w+\s+import|print\(/m.test(head)) return 'python';
  if (/^\s*package\s+\w+|^\s*func\s+\w+\(|\binterface\s*{/m.test(head)) return 'go';
  if (/^\s*fn\s+\w+\(|^\s*use\s+\w+::|^\s*impl\s+/m.test(head)) return 'rust';
  if (/#include\s*<|int\s+main\s*\(/.test(head)) return 'cpp';
  return '';
}

/**
 * Detect runs of "code-shaped" lines in the filtered output and wrap
 * them in Markdown ``` fences so the backend's codeBlockParser
 * surfaces them to the mobile feed as proper code blocks (monospace
 * + copy button + syntax highlighting on the renderer side).
 *
 * Definition of a code block:
 *   - ≥3 lines where each line either matches CODE_CHAR_RE OR is a
 *     blank line surrounded by code-shaped lines OR is indented
 *     continuation of a code-shaped line.
 *   - Any single isolated code-shaped line is left as plain text
 *     (avoids false positives on prose that happens to contain
 *     `function` or a stray `{`).
 *
 * Pure function — does not mutate the input array.
 */
export function wrapCodexCodeBlocks(lines: string[]): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!CODE_CHAR_RE.test(line)) {
      result.push(line);
      i++;
      continue;
    }
    // Greedily extend the run. Allow blank lines INSIDE the run (as
    // long as they're sandwiched between code-shaped lines) and
    // indented continuation lines (no code chars but indented under
    // the previous code-shaped line — function bodies, etc.).
    const start = i;
    let end = i;
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (CODE_CHAR_RE.test(l)) {
        end = j;
        j++;
        continue;
      }
      // Blank line: peek further. If the next non-blank line is
      // also code-shaped, this blank is part of the block.
      if (l.trim() === '') {
        let k = j + 1;
        while (k < lines.length && lines[k].trim() === '') k++;
        if (k < lines.length && CODE_CHAR_RE.test(lines[k])) {
          end = k;
          j = k + 1;
          continue;
        }
        break;
      }
      // Indented continuation (e.g., a long argument list): keep
      // extending if the line has ≥2 space indent.
      if (/^\s{2,}\S/.test(l)) {
        end = j;
        j++;
        continue;
      }
      break;
    }
    const runLen = end - start + 1;
    // Require at least 3 code-shaped lines to commit. Isolated
    // matches (one-liner with `{` in prose) stay as text.
    const codeShapedCount = lines.slice(start, end + 1).filter(l => CODE_CHAR_RE.test(l)).length;
    if (codeShapedCount >= 3) {
      const body = lines.slice(start, end + 1);
      const lang = inferLanguage(body);
      result.push('```' + lang);
      for (const l of body) result.push(l);
      // Strip any trailing blank lines before the closing fence — the
      // codeBlockParser already drops a single trailing newline but
      // a clean fence is nicer.
      while (result.length > 0 && result[result.length - 1].trim() === '') {
        result.pop();
      }
      result.push('```');
      i = end + 1;
    } else {
      // Not enough code lines — leave as plain text.
      for (let k = start; k <= end && k < lines.length; k++) result.push(lines[k]);
      i = end + 1;
      if (i === start) i++; // safety: ensure forward progress
    }
    void runLen; // retained for readability of the algorithm
  }
  return result;
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
