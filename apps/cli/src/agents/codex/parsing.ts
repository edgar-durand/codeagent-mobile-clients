import type { ChromeStep, SelectPrompt } from '@codeagent/shared';
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
// Negative lookahead skips `> 1. text` — those are the cursored option in
// an interactive numbered selector and must be kept so the line reaches
// `detectCodexSelector` (selector detection runs on lines BEFORE this
// filter, but echo-stripping the cursored option ALSO drops it from the
// fallback raw-text render when the selector trailer isn't present yet).
const CODEX_USER_ECHO_RE = /^[›>]\s+(?!\d+\.\s)\S/u;
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

  // Pre-pass: dedent Codex's chat-margin from lines that look like
  // they belong to a structured block (diff metadata + body). Codex
  // renders the chat with a 2-space left padding, which means
  // `@@ -1,6 +1,8 @@` arrives as `  @@ -1,6 +1,8 @@` — neither our
  // own structured-block guard nor the backend's diffBlockParser
  // recognize it (both use `^@@`-anchored regexes). Dedenting first
  // makes both fire correctly.
  const dedented = dedentCodexStructuredLines(out);

  // Post-pass: wrap Codex-emitted code blocks in Markdown ``` fences.
  // Codex's TUI does syntax-highlighted code with no explicit fence
  // markers — just an indented run of code-shaped lines. The mobile /
  // web feed renders fenced code blocks with a copy button + monospace
  // styling via the backend's codeBlockParser; without fences, the
  // body comes through as a plain TextBlock and the user gets a
  // wall of unformatted text. Injecting fences here is Codex-only:
  // Claude (which emits proper ```lang fences itself) goes through
  // its own filter and is unaffected.
  const wrapped = wrapCodexCodeBlocks(dedented);

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
    const sampleOut = dedented.map((l, i) => `  out[${i}] ${JSON.stringify(l)}`).join('\n');
    log.info('codex-parse', `in=${lines.length} out=${dedented.length}\n${sampleIn}\n---\n${sampleOut}`);
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
 * Markers that prove a line is part of a structured block the backend
 * already parses ahead of `codeBlockParser` (diff, commit, push, PR,
 * merge). If a candidate "code run" hits any of these, we must NOT
 * wrap it in ``` fences — the codeBlockParser would consume the
 * content and pre-empt the specialized renderer. Mirrors the regexes
 * in apps/api/src/lib/contentParsers/{gitBlockParser,diffBlockParser}.ts;
 * keep in sync if those parsers add new shapes.
 */
const DIFF_HUNK_RE   = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/;
const DIFF_GIT_RE    = /^diff\s+--git\s+/;
const DIFF_OLD_RE    = /^---\s+(?:a\/)?\S/;
const DIFF_NEW_RE    = /^\+\+\+\s+(?:b\/)?\S/;
const COMMIT_HEAD_RE = /^\[[\w./@-]+\s+[0-9a-f]{7,40}\]\s+/;
const COMMIT_STATS_RE= /\d+\s+files?\s+changed/;
const PUSH_TO_RE     = /^To\s+(?:https?:\/\/|git@)/;
const PUSH_NEW_RE    = /\[new branch\]\s+\S+\s*->\s*\S+/;
const PUSH_UPDATE_RE = /^\s*[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}\s+\S+\s*->\s*\S+/;
const MERGE_UPD_RE   = /^Updating\s+[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}/;
const MERGE_FF_RE    = /^Fast-forward\s*$/;
const PR_TITLE_RE    = /^title:\s+\S/;
const PR_STATE_RE    = /^state:\s+(?:OPEN|CLOSED|MERGED|DRAFT)/i;
const PR_URL_RE      = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
const PR_BANNER_RE   = /^\s*[✓✔]?\s*Pull request created\s*$/i;

/**
 * Codex's TUI left-pads chat content with 2 spaces, so every
 * structural marker the backend recognizes — diff (`diff --git`,
 * `@@`, `---`, `+++`), merge (`Updating <hash>`, `Fast-forward`,
 * `Merge made by`), push (`To <repo>`), commit (`[<branch> <hash>]`),
 * fetch (`From <repo>`) — arrives at column 2 instead of column 0.
 * The backend's parsers all anchor those markers with `^`, so the
 * indented form silently fails to parse: the content falls through
 * to `filePathLinkifier`, which mangles every `a/path`, `b/path`,
 * or `src/foo.ts` into a READ pill, breaking the structured render.
 *
 * Detect the chat margin from any marker line, then dedent every
 * line by that amount. Relative indent inside the body is preserved
 * (diff context-space, `+`/`-` markers, code indent). No-op when no
 * marker has leading whitespace (markers already at col 0).
 */
function dedentCodexStructuredLines(lines: string[]): string[] {
  // Markers grouped by structured-block kind. Each alternative is a
  // unique-enough head fragment to identify the block from one line.
  // Kept conservative: false positives just leave the line alone.
  const MARKER_RE =
    /^( +)(?:diff --git |@@ |--- |\+\+\+ |Updating [0-9a-f]|Fast-forward|Merge made by |To (?:https?:\/\/|git@|github\.com|[\w.-]+[:/])|From (?:https?:\/\/|git@|github\.com|[\w.-]+[:/])|\[[\w./@-]+\s+[0-9a-f]{7,40}\])/;

  let margin = -1;
  for (const line of lines) {
    const m = line.match(MARKER_RE);
    if (m) {
      const w = m[1].length;
      if (margin === -1 || w < margin) margin = w;
    }
  }
  if (margin <= 0) return lines;
  return lines.map((line) => {
    if (line.length === 0) return line;
    const lead = line.match(/^ */)?.[0].length ?? 0;
    const strip = Math.min(margin, lead);
    return strip > 0 ? line.slice(strip) : line;
  });
}

/**
 * True when the candidate run looks like a structured-block shape the
 * backend's specialized parsers handle (diff / commit / PR / push /
 * merge). Wrapping such content in ``` fences would let the
 * codeBlockParser consume it first and pre-empt the specialized
 * renderer (mobile would render the diff as Python code, etc).
 */
function isStructuredBlock(block: string[]): boolean {
  // Unified diff — hunk header is the strongest single signal.
  if (block.some(l => DIFF_HUNK_RE.test(l))) return true;
  // Git diff header + file markers (`diff --git` alone or `---` + `+++`).
  if (block.some(l => DIFF_GIT_RE.test(l))) return true;
  if (block.some(l => DIFF_OLD_RE.test(l)) && block.some(l => DIFF_NEW_RE.test(l))) return true;
  // Commit — header `[branch hash] subject` or the X-files-changed stats.
  if (block.some(l => COMMIT_HEAD_RE.test(l))) return true;
  if (block.some(l => COMMIT_STATS_RE.test(l))) return true;
  // Push — `To <remote>` + the new-branch / update lines.
  if (block.some(l => PUSH_TO_RE.test(l))) return true;
  if (block.some(l => PUSH_NEW_RE.test(l))) return true;
  if (block.some(l => PUSH_UPDATE_RE.test(l))) return true;
  // Merge.
  if (block.some(l => MERGE_UPD_RE.test(l))) return true;
  if (block.some(l => MERGE_FF_RE.test(l))) return true;
  // Pull request — `gh pr view` field block, or a pull-request URL, or
  // the "Pull request created" banner.
  if (block.some(l => PR_TITLE_RE.test(l)) && block.some(l => PR_STATE_RE.test(l))) return true;
  if (block.some(l => PR_URL_RE.test(l))) return true;
  if (block.some(l => PR_BANNER_RE.test(l))) return true;
  return false;
}

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
  // Whole-input guard: if the message contains a structured block
  // (diff, commit, push, merge, PR), skip wrapping entirely.
  // Structured-block markers usually appear in HEADERS *outside* the
  // code-shaped run (e.g. `@@ -1,10 +1,18 @@` sits BEFORE the
  // `def saludar(nombre):` line that triggers our run-start), so a
  // body-only guard misses them. The trade-off: a message that mixes
  // a prose paragraph + a real code block + a separate diff would
  // lose code-block wrapping. That combination is exceedingly rare
  // and accepting the trade-off is far better than the alternative
  // (mobile rendering a diff as a Python code block, as Edgar
  // reported on 2026-05-14).
  if (isStructuredBlock(lines)) {
    return lines;
  }

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
    // Bail-out: if the candidate run is actually a diff / commit /
    // push / PR / merge block, leave it as plain lines — the
    // backend's specialized parsers (registered ahead of
    // codeBlockParser) will turn it into the right component.
    // Wrapping it in ``` fences here would let codeBlockParser
    // eat it first and the diff/commit/etc. renderer never fires.
    const body = lines.slice(start, end + 1);
    if (isStructuredBlock(body)) {
      for (const l of body) result.push(l);
      i = end + 1;
      continue;
    }
    // Require at least 3 code-shaped lines to commit. Isolated
    // matches (one-liner with `{` in prose) stay as text.
    const codeShapedCount = body.filter(l => CODE_CHAR_RE.test(l)).length;
    if (codeShapedCount >= 3) {
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

// ─── selector regexes (named for readability + reuse) ────────────────────
//
// Codex renders both legacy `>` and the curly-quote `›` (U+203A) as the
// cursor glyph depending on terminal font / Codex build. Treat them
// identically.
//
// Numbered option line: optional cursor prefix, then `<digit>.<space><text>`.
//   matches: "› 1. Yes, continue"
//   matches: "  2. No, quit"
//   matches: "> 1. Yes, proceed (y)"
const CODEX_OPTION_RE = /^\s*([>›]\s+)?(\d+)\.\s+(.+)/;
// Same regex but anchored to the START of a STRIPPED line — used by the
// "is the first non-empty post-question line a numbered option?" check.
const CODEX_OPTION_START_RE = /^\s*(?:[>›]\s+)?\d+\.\s/;
// Footer phrases Codex emits below an interactive selector. None of these
// alone is a strong signal — but their presence reinforces the structural
// detection below.
const CODEX_FOOTER_RE = /\bpress\s+enter\s+to\s+(?:confirm|continue|select)\b/i;

/**
 * Detect Codex's numbered-choice prompt. Examples of supported shapes:
 *
 *   Trust-directory dialog (no cursor on `>` rendering, uses `›`):
 *     Do you trust the contents of this directory? …
 *     › 1. Yes, continue
 *       2. No, quit
 *     Press enter to continue
 *
 *   Shell-approval flow (cursor on first option, ASCII `>`):
 *     Would you like to run the following command?
 *     > 1. Yes, proceed (y)
 *       2. Yes, and don't ask again for commands that start with `…` (p)
 *       3. No, and tell Codex what to do differently (esc)
 *     Press enter to confirm or esc to cancel
 *
 *   Generic numbered choice:
 *     What should I do next?
 *     1. Run the tests
 *     2. Open a PR
 *
 * Detection strategy (most-to-least specific):
 *
 *   1. STRUCTURAL: at least 2 contiguous numbered lines, starting at
 *      `1.`. This is the load-bearing signal — narrative numbered lists
 *      Codex emits inside plans show up the same way at the text level,
 *      so we lean on context to disambiguate (see #2 + #3).
 *   2. CONTEXTUAL: AT LEAST ONE of these reinforcers must be present:
 *        a. A cursor glyph (`>` or `›`) at the start of one of the
 *           numbered lines — this is what React Ink renders to show
 *           which option is currently selected, and it NEVER appears
 *           on narrative numbered lists.
 *        b. A question-mark-terminated line preceding the options
 *           AND at least one of the standard "press enter to …"
 *           footers below them. The `?` + footer combo together
 *           reach a high-confidence threshold even in the no-cursor
 *           case (terminal font ate the glyph, PTY rendering pass
 *           lost it, etc.).
 *      This split keeps the detector permissive enough to catch the
 *      trust-directory + similar dialogs while still rejecting
 *      mid-plan numbered lists.
 *   3. The first numbered option must be `1.` and there must be ≥2
 *      consecutive options. Plans that start at e.g. `3.` are
 *      ignored.
 *
 * Rationale for moving away from "footer is required":
 *   The previous detector required `press enter to confirm` literally.
 *   That missed the trust-directory dialog (which says `press enter to
 *   continue`) and was brittle against any future Codex copy change.
 *   The structural cursor signal is what React Ink ALWAYS renders for
 *   an interactive selector, and it's what truly distinguishes a
 *   selector from a plain numbered list.
 */
export function detectCodexSelector(lines: string[]): SelectPrompt | null {
  // Idle composer guard: when Codex is sitting at its input box
  // (no active prompt), the LAST non-empty line is the user
  // composer — typically a single `›` glyph on a line of its own
  // (the React Ink input cursor), or the `▌` block-cursor variant.
  // If that's visible, any numbered list above is narrative
  // content from a prior agent reply, NOT an interactive
  // selector. Codex hides the composer entirely while a real
  // prompt is awaiting input.
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    // A bare cursor / block-cursor on its own line means the
    // composer is visible.
    if (/^[›>]\s*$/.test(t) || /^▌\s*$/.test(t)) return null;
    // Hint footer Codex prints at the bottom of the idle
    // composer ("send: ⏎"). Same signal — composer is up.
    if (/^send:\s*⏎|^esc to interrupt/i.test(t)) return null;
    break; // last non-empty line is something else — proceed
  }

  // 1. Locate the first numbered-option line.
  let optionStartIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (CODEX_OPTION_START_RE.test(lines[i])) {
      optionStartIdx = i;
      break;
    }
  }
  if (optionStartIdx === -1) return null;

  // 2. Collect contiguous numbered options after that line. Stop at a
  //    footer or an unrelated line (lets us treat e.g. an inline plan
  //    snippet at the bottom of an agent reply correctly).
  const optionLabels = new Map<number, string>();
  let cursorIndex = 0;
  let hasCursor = false;
  let footerAfterOptions = false;
  let lastOptionLineIdx = optionStartIdx;

  for (let i = optionStartIdx; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) continue;
    if (CODEX_FOOTER_RE.test(t)) {
      footerAfterOptions = true;
      break;
    }
    const m = t.match(CODEX_OPTION_RE);
    if (!m) {
      // Non-option, non-footer line. Tolerate one short line (option
      // descriptions can wrap), but don't keep scanning forever.
      if (i - lastOptionLineIdx > 2) break;
      continue;
    }
    const num = parseInt(m[2], 10);
    if (!optionLabels.has(num)) {
      optionLabels.set(num, m[3].trim());
      if (m[1]) {
        cursorIndex = optionLabels.size - 1;
        hasCursor = true;
      }
    }
    lastOptionLineIdx = i;
  }

  const keys = [...optionLabels.keys()].sort((a, b) => a - b);
  // Structural baseline: ≥2 options, starting at 1.
  if (keys.length < 2 || keys[0] !== 1) return null;

  // 3. Build the question text from the lines above the options.
  const questionParts: string[] = [];
  for (let i = 0; i < optionStartIdx; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    // Bare cursor line (defensive); user-prompt echo line `› hola`
    // (matches when the optionStart is several lines below — keep the
    // strict "trim must equal '›'" so we don't drop legit prefixed
    // question text).
    if (/^[>›]\s*$/.test(t)) continue;
    questionParts.push(t);
  }
  const question = questionParts.join('\n').trim();

  // 4. Reinforcer check — see the JSDoc above. Either the cursor was
  //    visible on one of the options, OR the question ends with `?`
  //    AND a footer line followed.
  const questionEndsWithQuery = /\?\s*$/.test(question);
  if (!hasCursor && !(questionEndsWithQuery && footerAfterOptions)) {
    return null;
  }

  return {
    question,
    options: keys.map(k => optionLabels.get(k)!),
    optionDescriptions: keys.map(() => ''),
    currentIndex: hasCursor ? cursorIndex : 0,
  };
}
