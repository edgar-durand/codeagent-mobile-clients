import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getContextWindow, type NormalizedMessage } from '@codeam/shared';

/**
 * Encode a cwd path to the matching Claude project directory name.
 *
 * Claude Code stores per-project session JSONLs under
 * `~/.claude/projects/<encoded-cwd>/`. Encoding rule: every path
 * separator (and the Windows drive-letter colon) becomes a single
 * dash, AND every underscore is likewise collapsed to a dash —
 * confirmed empirically against a live `claude` binary (v2.1.204):
 * running `claude -p … --session-id …` from a cwd ending in
 * `encode_test_dir` produced a project dir ending in
 * `encode-test-dir`, i.e. `_` → `-` just like a path separator.
 *
 *   macOS / Linux: `/Users/me/my_project` → `-Users-me-my-project`
 *   Windows:       `C:\Users\me\foo`      → `C--Users-me-foo`
 *                  (`:\` collapses to `--` because both characters
 *                   are replaced; matches Claude Code's own scheme)
 *
 * The previous implementation only replaced `/ \ :`, so any cwd
 * containing an underscore encoded to a directory name Claude never
 * actually creates — every history-driven feature (terminal-typed-
 * prompt detection, conversation loading, `waitForNewUserMessage`,
 * the baton `TranscriptMirror`) silently no-op'd for those projects.
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[\\/:_]/g, '-');
}

/**
 * Find the Claude project directory for `cwd`. Tries the canonical
 * encoding first; if that directory doesn't exist on disk, scans
 * the projectsRoot for a directory whose name *would* encode to
 * the same canonical form when slashes/colons are normalized — this
 * salvages cases where a future Claude version tweaks the encoding
 * without us shipping a CLI update. Returns `null` if no candidate
 * matches.
 *
 * Renamed from `findProjectDir` in history.service.ts to expose a
 * stable, testable API for the RuntimeStrategy pattern (C.4).
 */
export function resolveHistoryDir(cwd: string, projectsRoot?: string): string | null {
  const root = projectsRoot ?? path.join(os.homedir(), '.claude', 'projects');
  const primary = path.join(root, encodeCwd(cwd));
  if (fs.existsSync(primary)) return primary;
  // Fallback — scan and match by canonicalized name. Cheap (one
  // readdir + a string compare each), and only runs when the primary
  // lookup misses, so the macOS/Linux happy path stays free.
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const wanted = encodeCwd(cwd);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // Compare on the canonical form: normalize each candidate the
      // same way we normalize the cwd, so cosmetic encoding drift
      // (single vs double dashes around drive letters, etc.) doesn't
      // hide a real match.
      const candidate = e.name.replace(/-+/g, '-');
      if (candidate === wanted.replace(/-+/g, '-')) {
        return path.join(root, e.name);
      }
    }
  } catch { /* projectsRoot doesn't exist yet — fall through */ }
  return null;
}

/**
 * Resolve the on-disk transcript file for a specific Claude session id, or
 * `null` when it doesn't (yet) exist.
 *
 * Claude's layout is simple relative to Codex's rollouts: the session id IS
 * the filename, `<resolveHistoryDir(cwd)>/<sessionId>.jsonl` — no need to key
 * off content inside the file. This is what powers the baton
 * `TranscriptMirror` (`src/baton/transcript-mirror.ts`): it was previously
 * inert for Claude because `ClaudeRuntimeStrategy` had no
 * `resolveHistoryFile`, so `TranscriptMirror.start()` always bailed out at
 * `if (!file) return`.
 */
export function resolveHistoryFile(
  cwd: string,
  sessionId: string,
  projectsRoot?: string,
): string | null {
  const dir = resolveHistoryDir(cwd, projectsRoot);
  if (!dir) return null;
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  return fs.existsSync(filePath) ? filePath : null;
}

/**
 * Read the most recently created JSONL in `historyDir` and extract the
 * context-window usage from the last assistant message.
 *
 * `bootTimeMs` is an optional birthtime filter (same semantics as
 * HistoryService.getCurrentUsage). When omitted or 0, all files are
 * eligible. When provided, only files created at or after
 * `bootTimeMs - 5000 ms` are considered — this prevents a parallel
 * Claude session's JSONL from leaking its stats into an unrelated
 * RuntimeStrategy caller.
 *
 * Returns the simplified shape required by RuntimeStrategy:
 *   { used, total, percent, model? }
 *
 * Returns null when the directory doesn't exist, contains no eligible
 * files, or the most-recent file has no assistant usage records.
 */
export function getCurrentUsage(
  historyDir: string,
  bootTimeMs: number = 0,
): { used: number; total: number; percent: number; model?: string } | null {
  const GRACE_MS = 5_000;
  const cutoff = bootTimeMs > 0 ? bootTimeMs - GRACE_MS : 0;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(historyDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => {
      try {
        const stat = fs.statSync(path.join(historyDir, e.name));
        return { name: e.name, mtime: stat.mtimeMs, birthtime: stat.birthtimeMs };
      } catch {
        return { name: e.name, mtime: 0, birthtime: 0 };
      }
    })
    .filter((f) => f.birthtime >= cutoff)
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) return null;

  const filePath = path.join(historyDir, files[0].name);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  let lastUsage: Record<string, number> | null = null;
  let lastModel: string | null = null;

  for (const line of raw.split('\n').filter(Boolean)) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record['type'] !== 'assistant') continue;
      const msg = record['message'] as Record<string, unknown> | undefined;
      if (msg?.['model'] === '<synthetic>') continue;
      const usage = msg?.['usage'] as Record<string, number> | undefined;
      if (usage && (usage['input_tokens'] !== undefined || usage['prompt_tokens'] !== undefined)) {
        lastUsage = usage;
      }
      if (msg?.['model']) lastModel = msg['model'] as string;
    } catch {
      /* skip malformed */
    }
  }

  const total = getContextWindow(lastModel);

  if (!lastUsage) {
    if (!lastModel) return null;
    return { used: 0, total, percent: 0, model: lastModel };
  }

  const inputTokens =
    (lastUsage['input_tokens'] ?? lastUsage['prompt_tokens'] ?? 0) +
    (lastUsage['cache_read_input_tokens'] ?? 0) +
    (lastUsage['cache_creation_input_tokens'] ?? 0);
  const percent = Math.min(100, Math.round((inputTokens / total) * 100));

  return {
    used: inputTokens,
    total,
    percent,
    model: lastModel ?? undefined,
  };
}

/** Extract plain text from a Claude message content field (string or ContentBlock[]). */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Record<string, unknown>[])
      .filter((b) => b['type'] === 'text')
      .map((b) => b['text'] as string)
      .join('\n');
  }
  return '';
}

/**
 * Parse a Claude Code JSONL session file into an array of NormalizedMessage
 * objects (user + assistant turns only). isMeta records are skipped.
 *
 * Returns an empty array on read errors (ENOENT, permission errors).
 *
 * Renamed from `parseJsonl` in history.service.ts; return type changed from
 * the internal ClaudeHistoryMessage (numeric timestamp) to NormalizedMessage
 * (string timestamp + usage) so RuntimeStrategy implementations can consume
 * it directly without an impedance mismatch.
 */
export function parseHistoryFile(filePath: string): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n').filter(Boolean)) {
    let rec: unknown;
    try { rec = JSON.parse(line); } catch { continue; }
    if (typeof rec !== 'object' || rec === null) continue;
    const r = rec as Record<string, unknown>;

    // isMeta=true marks injected context (skills, hooks, system prompts) — skip
    if (r['isMeta']) continue;

    const type = r['type'];
    if (type !== 'user' && type !== 'assistant') continue;

    const msg = r['message'] as Record<string, unknown> | undefined;
    if (!msg) continue;

    const text = extractText(msg['content']).trim();
    if (!text) continue;
    // A local slash command (`/clear`, `/rename`, …) is echoed into the
    // transcript as a `user` record wrapping `<command-name>…</command-name>`.
    // It is TUI bookkeeping, not a conversation turn — surfacing it would
    // render "<command-name>/clear</command-name>" as a user bubble on mobile
    // and leave a never-answered turn open ("Thinking…").
    if (type === 'user' && isLocalCommandEcho(text)) continue;

    const ts = r['timestamp'];
    const timestamp =
      typeof ts === 'string'
        ? ts
        : typeof ts === 'number'
          ? new Date(ts).toISOString()
          : new Date().toISOString();

    const uuid = typeof r['uuid'] === 'string' ? r['uuid'] : `${Date.now()}-${Math.random()}`;
    const usage = msg['usage'] as Record<string, number> | undefined;

    out.push({
      id: uuid,
      role: type === 'user' ? 'user' : 'agent',
      text,
      timestamp,
      modelId: typeof msg['model'] === 'string' ? msg['model'] : undefined,
      usage: usage
        ? {
            input: usage['input_tokens'] ?? 0,
            output: usage['output_tokens'] ?? 0,
            cacheRead: usage['cache_read_input_tokens'],
            cacheCreation: usage['cache_creation_input_tokens'],
          }
        : undefined,
    });
  }
  return out;
}

/**
 * Enumerate every resumable Claude session under
 * `~/.claude/projects/<cwd-encoded>/`. One file per session; `id` is
 * the JSONL filename without the `.jsonl` extension. `summary` is the
 * first user message (trimmed to 120 chars) so the Conversations
 * sheet has a label; `timestamp` is the file's mtime in ms.
 *
 * Lifted out of `HistoryService.load()` so the surface lives next to
 * the agent it belongs to (per the per-agent-parser encapsulation
 * rule). The behaviour is byte-for-byte identical to what the legacy
 * inline implementation did.
 */
export function listResumableSessions(cwd: string): Array<{
  id: string;
  summary: string;
  timestamp: number;
}> {
  const dir = resolveHistoryDir(cwd);
  if (!dir) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ id: string; summary: string; timestamp: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const id = entry.name.slice(0, -'.jsonl'.length);
    const filePath = path.join(dir, entry.name);
    let timestamp = Date.now();
    try {
      timestamp = fs.statSync(filePath).mtimeMs;
    } catch {
      /* ignore */
    }
    let summary = '';
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          if (record['type'] === 'user') {
            const msg = record['message'] as Record<string, unknown> | undefined;
            const text = extractText(msg?.['content']).trim();
            if (text) {
              summary = text.slice(0, 120);
              break;
            }
          }
        } catch {
          /* skip malformed line */
        }
      }
    } catch {
      /* skip */
    }
    if (summary) out.push({ id, summary, timestamp });
  }
  out.sort((a, b) => b.timestamp - a.timestamp);
  return out;
}

/**
 * Claude Code echoes every local slash command into the transcript as a
 * `user` record whose content is `<command-name>/x</command-name>…` (plus
 * `<local-command-stdout>` / `<local-command-caveat>` wrappers). Verified
 * live on claude 2.1.235: `/clear` → `<command-name>/clear</command-name>`,
 * `/rename foo` → `<command-name>/rename</command-name>…<command-args>foo`.
 */
export function isLocalCommandEcho(text: string): boolean {
  return /^\s*<(command-name|local-command-[a-z]+)>/.test(text);
}

const CLEAR_COMMAND_ECHO = '<command-name>/clear</command-name>';
/** Read at most this much of a candidate transcript when classifying it — the
 *  `/clear` echo sits in the first handful of records. */
const SWITCH_PROBE_BYTES = 256 * 1024;

/**
 * Does `filePath` look like a conversation the INTERACTIVE TUI started with
 * `/clear`? Two independent markers, either suffices:
 *   - a `user` record echoing `<command-name>/clear</command-name>` — written
 *     by the TUI itself the moment `/clear` runs (before any turn);
 *   - a `SessionStart:clear` hook attachment (only present when the user has
 *     SessionStart hooks configured, so it is the secondary signal).
 * A `claude -p` one-shot (preview detection, AI summaries — same cwd, same
 * project dir) or the ACP adapter's session never carries either, so they
 * can't hijack the baton.
 */
export function isClearedConversationFile(filePath: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return false;
  }
  let raw: string;
  try {
    const buf = Buffer.alloc(SWITCH_PROBE_BYTES);
    const n = fs.readSync(fd, buf, 0, SWITCH_PROBE_BYTES, 0);
    raw = buf.toString('utf8', 0, n);
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
  // Cheap pre-check before parsing line by line.
  if (!raw.includes(CLEAR_COMMAND_ECHO) && !raw.includes('SessionStart:clear')) return false;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // the probe window may cut the last line mid-record
    }
    if (r['type'] === 'user' && !r['isMeta']) {
      const msg = r['message'] as Record<string, unknown> | undefined;
      if (extractText(msg?.['content']).trimStart().startsWith(CLEAR_COMMAND_ECHO)) return true;
    }
    if (r['type'] === 'attachment') {
      const att = r['attachment'] as Record<string, unknown> | undefined;
      if (typeof att?.['hookName'] === 'string' && att['hookName'].startsWith('SessionStart:clear')) {
        return true;
      }
    }
  }
  return false;
}

/** Why the native TUI switched conversation — `new` = `/clear` (fresh
 *  transcript), `resumed` = `/resume` (an existing transcript picked up again). */
export type ConversationSwitchKind = 'new' | 'resumed';

/**
 * Does the bytes appended to a transcript since `fromOffset` carry Claude's
 * RESUME signature? Verified live (claude 2.1.235, 2026-08-19, both `/resume
 * <id>` and the interactive `/resume` picker): the instant a conversation is
 * resumed, claude appends exactly one `last-prompt` record to ITS file (the
 * previously-active file gets nothing), before any turn. A normal turn also
 * ends in a `last-prompt`, so a resume that somehow skipped the immediate
 * record is still attributed by its first turn.
 */
function appendedTailHasResumeMarker(filePath: string, fromOffset: number): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return false;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(Math.max(size - fromOffset, 0), SWITCH_PROBE_BYTES);
    if (len <= 0) return false;
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, fromOffset);
    const raw = buf.toString('utf8', 0, n);
    if (!raw.includes('"last-prompt"')) return false;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        if ((JSON.parse(line) as Record<string, unknown>)['type'] === 'last-prompt') return true;
      } catch {
        /* partial line at either edge of the tail */
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Watch `~/.claude/projects/<encodeCwd(cwd)>/` for the native TUI switching
 * conversation — `/clear` (NEW transcript) or `/resume` (an EXISTING
 * transcript) — and call `onSwitch(newId, {kind})`, once per switch, for as
 * long as the watcher lives (every later `/clear`/`/resume` fires again).
 *
 * Verified live (claude 2.1.235, 2026-08-19):
 *   - `/clear` mints a fresh session id and IMMEDIATELY writes `<newId>.jsonl`
 *     (a `user` record echoing `<command-name>/clear</command-name>`), before
 *     the user types anything; the old file is never touched again.
 *   - `/resume <id>` and the interactive `/resume` picker IMMEDIATELY append
 *     one `last-prompt` record to the RESUMED `<id>.jsonl`; the file that was
 *     active gets nothing.
 *   - `/rename` writes `custom-title` / `agent-name` records into the CURRENT
 *     file — no new conversation.
 *
 * Attribution (so a `claude -p` one-shot — preview detection / AI summary,
 * same cwd — or the ACP adapter can never hijack the baton):
 *   - every `*.jsonl` present when the watch attaches is a KNOWN conversation
 *     (baselined at its current size); the current one is excluded;
 *   - a file that APPEARS later is a `/clear` candidate only if
 *     {@link isClearedConversationFile} says the interactive TUI created it —
 *     anything else (a one-shot) stays unclassified and is never followed;
 *   - a KNOWN, non-current file that GROWS with a `last-prompt` record in the
 *     appended tail is a `/resume` — only the interactive TUI writes to old
 *     conversations of this cwd. A conversation we switched AWAY from is
 *     baselined at that moment, so `/clear` → `/resume <old>` round-trips.
 *
 * EVENT-DRIVEN ONLY (repo "no polling" rule): an `fs.watch` on the project
 * dir; when that dir doesn't exist yet (no turn before the first `/clear`) an
 * `fs.watch` on the projects root catches its creation. Every event rescans,
 * re-probing a file only when its size changed.
 */
export function watchConversationSwitch(
  cwd: string,
  opts: { currentId: string },
  onSwitch: (conversationId: string, info: { kind: ConversationSwitchKind }) => void,
  projectsRoot?: string,
): () => void {
  const root = projectsRoot ?? path.join(os.homedir(), '.claude', 'projects');
  let currentId = opts.currentId;
  /** Known conversations (not current) → size when last known idle. */
  const baseline = new Map<string, number>();
  /** Files that appeared after attach and did NOT qualify as a `/clear`
   *  (one-shots, other processes) → size at last probe. */
  const unclassified = new Map<string, number>();
  let dirWatcher: fs.FSWatcher | null = null;
  let rootWatcher: fs.FSWatcher | null = null;
  let closed = false;

  const fileSize = (file: string): number | null => {
    try {
      return fs.statSync(file).size;
    } catch {
      return null;
    }
  };

  const switchTo = (dir: string, id: string, kind: ConversationSwitchKind): void => {
    // The conversation we leave becomes a known, resumable one — baseline it
    // NOW so a later `/resume <it>` is seen as growth.
    const leaving = fileSize(path.join(dir, `${currentId}.jsonl`));
    if (leaving !== null) baseline.set(currentId, leaving);
    baseline.delete(id);
    unclassified.delete(id);
    currentId = id;
    onSwitch(id, { kind });
  };

  const scan = (dir: string): void => {
    if (closed) return;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -'.jsonl'.length);
      if (id === currentId) continue;
      const file = path.join(dir, name);
      const size = fileSize(file);
      if (size === null) continue;
      const known = baseline.get(id);
      if (known !== undefined) {
        // A known conversation grew → `/resume` if the tail carries the marker.
        if (size > known && appendedTailHasResumeMarker(file, known)) {
          switchTo(dir, id, 'resumed');
          return;
        }
        continue;
      }
      // Appeared after attach: `/clear` candidate (re-probe only on growth).
      if (unclassified.get(id) === size) continue;
      unclassified.set(id, size);
      if (isClearedConversationFile(file)) {
        switchTo(dir, id, 'new');
        return;
      }
    }
  };

  /** Attach to the project dir. On the INITIAL attach every present file is a
   *  known conversation; when the dir is created later (root-watch path) the
   *  files in it are new by construction. */
  const attachDir = (initial: boolean): boolean => {
    const dir = resolveHistoryDir(cwd, root);
    if (!dir) return false;
    rootWatcher?.close();
    rootWatcher = null;
    if (initial) {
      try {
        for (const name of fs.readdirSync(dir)) {
          if (!name.endsWith('.jsonl')) continue;
          const id = name.slice(0, -'.jsonl'.length);
          if (id === currentId) continue;
          const size = fileSize(path.join(dir, name));
          if (size !== null) baseline.set(id, size);
        }
      } catch {
        /* unreadable dir — treated as empty */
      }
    }
    try {
      dirWatcher = fs.watch(dir, { persistent: false }, () => scan(dir));
    } catch {
      return false;
    }
    scan(dir); // anything that landed between the event and the watch
    return true;
  };

  if (!attachDir(true)) {
    // No project dir yet (claude creates it on the first transcript write —
    // which a `/clear` before any turn also does). Watch the root for it.
    try {
      fs.mkdirSync(root, { recursive: true });
      rootWatcher = fs.watch(root, { persistent: false }, () => {
        if (!closed && !dirWatcher) attachDir(false);
      });
    } catch {
      /* no root watch possible — the switch simply won't be detected */
    }
  }

  return () => {
    closed = true;
    dirWatcher?.close();
    rootWatcher?.close();
    dirWatcher = null;
    rootWatcher = null;
  };
}
