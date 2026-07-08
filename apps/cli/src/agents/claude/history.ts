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
