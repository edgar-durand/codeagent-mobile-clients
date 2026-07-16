import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { z } from 'zod';
import {
  resolveApiBaseUrl,
  getContextWindow,
  getPricing,
  type NormalizedMessage,
} from '@codeam/shared';
import { vercelBypassHeader } from '../lib/backend-headers';
import { log } from './logger';
import { encodeCwd } from '../agents/claude/history';
import type { RuntimeStrategy } from '../agents/strategy';

/**
 * Schema for one record in a Claude Code session JSONL file. Only fields
 * actually consumed by parseJsonl are validated — the file may carry many
 * other keys (tool calls, internal IDs, etc.) and we deliberately ignore
 * them via `.passthrough()`. A schema mismatch (corruption, version
 * skew, partial write) results in the record being skipped with a warn
 * log rather than producing undefined values that break downstream code.
 */
const historyRecordSchema = z
  .object({
    type: z.string().optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    uuid: z.string().optional(),
    isMeta: z.boolean().optional(),
    message: z
      .object({
        // Claude content is either a string or an array of typed blocks.
        content: z.union([z.string(), z.array(z.unknown())]).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type HistoryRecord = z.infer<typeof historyRecordSchema>;

const API_BASE = resolveApiBaseUrl();

interface ClaudeSession {
  id: string;
  summary: string;
  timestamp: number;
}

interface ClaudeHistoryMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  timestamp: number;
}

// Re-export encodeCwd so callers that import it from this module
// (e.g. __tests__/history-encoding.test.ts) continue to work unchanged.
export { encodeCwd };

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

const CONVERSATION_BATCH_SIZE = 30;

/** Parse a JSONL session file into a list of ChatMessages (user + assistant only). */
function parseJsonl(filePath: string): ClaudeHistoryMessage[] {
  const messages: ClaudeHistoryMessage[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    // ENOENT is expected (file was deleted between scan and read); anything
    // else — permission errors, I/O errors — is worth a breadcrumb.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('history:parseJsonl', `read failed for ${filePath}`, err);
    }
    return messages;
  }
  const lines = raw.split('\n').filter(Boolean);
  for (const line of lines) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      // malformed JSON — skip
      continue;
    }
    const result = historyRecordSchema.safeParse(parsedJson);
    if (!result.success) {
      log.warn('history:parseJsonl', `record failed schema validation in ${filePath}`, result.error.issues);
      continue;
    }
    const record: HistoryRecord = result.data;

    // isMeta=true marks injected context (skills, hooks, system prompts) — skip
    if (record.isMeta) continue;

    const ts = record.timestamp;
    const timestamp =
      typeof ts === 'string' ? new Date(ts).getTime() : typeof ts === 'number' ? ts : Date.now();
    const uuid = record.uuid ?? `${Date.now()}-${Math.random()}`;
    const msg = record.message;

    if (record.type === 'user' && msg) {
      const text = extractText(msg.content).trim();
      if (text) messages.push({ id: uuid, role: 'user', text, timestamp });
    } else if (record.type === 'assistant' && msg) {
      const text = extractText(msg.content).trim();
      if (text) messages.push({ id: uuid, role: 'agent', text, timestamp });
    }
  }
  return messages;
}

/** POST JSON to the API. Returns true on 2xx, false on error/timeout/non-2xx. */
function post(
  endpoint: string,
  body: Record<string, unknown>,
  pluginAuthToken?: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const u = new URL(`${API_BASE}${endpoint}`);
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...vercelBypassHeader(),
          // SEC crit1 (#819): authenticate conversation-history writes so
          // the backend can verify the (sessionId, pluginId) ownership.
          // Older backends ignore the header.
          ...(pluginAuthToken
            ? { 'X-Plugin-Auth-Token': pluginAuthToken }
            : {}),
        },
        timeout: 15000,
      },
      (res) => {
        res.resume(); // drain response body
        const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
        if (!ok) log.warn('history:post', `${endpoint} → HTTP ${res.statusCode}`);
        resolve(ok);
      },
    );
    req.on('error', (err) => {
      log.warn('history:post', `${endpoint} network error`, err);
      resolve(false);
    });
    req.on('timeout', () => {
      log.warn('history:post', `${endpoint} timeout after 15s`);
      req.destroy();
      resolve(false);
    });
    req.write(payload);
    req.end();
  });
}

export interface ContextUsage {
  used: number;
  total: number;
  percent: number;
  model: string | null;
  outputTokens: number;
  cacheReadTokens: number;
  monthlyCost?: number;
  rateLimitReset?: string;
  quotaPercent?: number;
}

export class HistoryService {
  private currentConversationId: string | null = null;
  private _rateLimitReset: string | null = null;
  private _quotaPercent: number | null = null;
  private _quotaFetchedAt: number = 0;
  /**
   * Per-conversation marker of the last message uuid we successfully
   * uploaded to the backend. `uploadDelta()` reads the JSONL,
   * filters out everything up to and including this uuid, and
   * uploads only the tail. Resets per conversation so a session
   * resume re-uploads the full transcript on first call.
   */
  private lastUploadedUuid = new Map<string, string>();
  /**
   * Captured at construction time so every JSONL discovery (detect,
   * usage stats) can ignore files that already existed in the
   * project's `~/.claude/projects/<cwd>/` dir *before* this CLI
   * run started. Without this filter, an old conversation — or
   * a *parallel* Claude session actively writing to the same
   * project — wins the mtime sort and we publish its content
   * to the mobile app as if it were the fresh pair's chat.
   */
  private readonly bootTimeMs: number;
  /**
   * Small grace window subtracted from `bootTimeMs` when filtering
   * by `birthtime`. Covers clock skew + filesystem timestamp
   * rounding (HFS+ floors to 1 s; some Linux filesystems round to
   * the nearest second). 5 s is comfortably wider than any
   * filesystem rounding while still excluding everything from a
   * previous pair / previous Claude run.
   */
  private static readonly BIRTHTIME_GRACE_MS = 5_000;

  private readonly runtime: RuntimeStrategy;
  private readonly pluginAuthToken?: string;

  constructor(
    runtime: RuntimeStrategy,
    private readonly pluginId: string,
    private readonly cwd: string,
    /**
     * Test seam — overrides the wall-clock construction time used
     * for the birthtime filter. Production callers omit this; tests
     * use it to simulate a CLI that started just after a pre-existing
     * parallel-session JSONL.
     *
     * `pluginAuthToken` (SEC crit1 #819) is replayed as
     * `X-Plugin-Auth-Token` on conversation-history writes so the
     * backend can authorize them.
     */
    options?: { bootTimeMs?: number; pluginAuthToken?: string },
  ) {
    this.runtime = runtime;
    this.pluginAuthToken = options?.pluginAuthToken;
    this.bootTimeMs = options?.bootTimeMs ?? Date.now();
  }

  /** Store rate limit reset info detected from Claude Code output */
  setRateLimitReset(reset: string): void {
    this._rateLimitReset = reset;
  }

  getRateLimitReset(): string | null {
    return this._rateLimitReset;
  }

  /** Store weekly quota usage percentage parsed from /usage output */
  setQuotaPercent(percent: number): void {
    this._quotaPercent = percent;
    this._quotaFetchedAt = Date.now();
  }

  getQuotaPercent(): number | null {
    return this._quotaPercent;
  }

  /** Check if the quota cache is stale (older than ttlMs, default 30 min) */
  isQuotaStale(ttlMs: number = 30 * 60 * 1000): boolean {
    return this._quotaPercent === null || (Date.now() - this._quotaFetchedAt) > ttlMs;
  }

  private get projectDir(): string {
    // Delegate to the runtime strategy's resolveHistoryDir, which
    // tries the canonical encoding first, then falls back to a
    // directory scan for cosmetic encoding drift. Fall back to the
    // derived path when the strategy returns null (directory doesn't
    // exist yet — e.g. first-ever Claude run in this cwd).
    return this.runtime.resolveHistoryDir(this.cwd)
      ?? path.join(os.homedir(), '.claude', 'projects', encodeCwd(this.cwd));
  }

  /** Set the current Claude conversation ID (extracted from /cost command or session start) */
  setCurrentConversationId(id: string): void {
    this.currentConversationId = id;
  }

  getCurrentConversationId(): string | null {
    return this.currentConversationId;
  }

  /** Return the current message count in the active conversation. */
  getCurrentMessageCount(): number {
    if (!this.currentConversationId) return 0;
    const filePath = path.join(this.projectDir, `${this.currentConversationId}.jsonl`);
    return parseJsonl(filePath).length;
  }

  /**
   * Poll the JSONL until a new user message appears after previousCount entries.
   * Returns the text of the new user message, or null if not found within timeoutMs.
   */
  async waitForNewUserMessage(previousCount: number, timeoutMs = 60_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.currentConversationId) return null;
      const filePath = path.join(this.projectDir, `${this.currentConversationId}.jsonl`);
      const messages = parseJsonl(filePath);
      if (messages.length > previousCount) {
        for (let i = messages.length - 1; i >= previousCount; i--) {
          if (messages[i].role === 'user') return messages[i].text;
        }
      }
      await new Promise<void>((r) => setTimeout(r, 150));
    }
    return null;
  }

  /**
   * Detect the active conversation by finding the most recently
   * modified JSONL file that was **created during this CLI run**.
   * The birthtime filter is critical: without it, an old
   * conversation in the same project dir — or a parallel Claude
   * session actively writing to a sibling JSONL — wins the mtime
   * sort, and we publish that other run's content to mobile as if
   * it were the fresh pair's chat. With the filter, only files
   * Claude created on or after `bootTimeMs` are eligible, so a
   * fresh pair stays empty until the user actually types a turn.
   */
  detectCurrentConversation(): void {
    const dir = this.projectDir;
    const cutoff = this.bootTimeMs - HistoryService.BIRTHTIME_GRACE_MS;
    try {
      const files = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
        .map(e => {
          try {
            const stat = fs.statSync(path.join(dir, e.name));
            return { name: e.name, mtime: stat.mtimeMs, birthtime: stat.birthtimeMs };
          }
          catch { return { name: e.name, mtime: 0, birthtime: 0 }; }
        })
        .filter(f => f.birthtime >= cutoff)
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) {
        this.currentConversationId = path.basename(files[0].name, '.jsonl');
      }
    } catch { /* silent */ }
  }

  /**
   * Extract conversation ID from Claude output. Limited to the
   * unambiguous "Resuming session: <uuid>" pattern — the older
   * generic `Session: <uuid>` / `Conversation: <uuid>` patterns
   * were too greedy and matched any incidental UUID-bearing line
   * Claude printed (debug logs, status info, etc.), causing the
   * CLI to "detect" the wrong conversation on a fresh pair.
   * Resume is the only flow that legitimately needs to bind via
   * output text; everything else sets `currentConversationId`
   * via `setCurrentConversationId()` or the birthtime-filtered
   * `detectCurrentConversation()`.
   */
  tryExtractConversationIdFromOutput(output: string): void {
    const match = output.match(/Resuming session[:\s]+([a-f0-9-]{36})/i);
    if (match) this.currentConversationId = match[1];
  }

  /**
   * Read the most recently modified JSONL session file and extract the
   * context window usage from the last assistant message's usage field.
   *
   * Claude Code records token counts per-response:
   *   input_tokens + cache_read_input_tokens + cache_creation_input_tokens
   *   = total context tokens consumed in that request.
   */
  getCurrentUsage(): ContextUsage | null {
    const dir = this.projectDir;
    const cutoff = this.bootTimeMs - HistoryService.BIRTHTIME_GRACE_MS;

    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return null; }

    // Same birthtime filter as `detectCurrentConversation`: the
    // fallback "most recent JSONL" branch otherwise reads usage
    // from a parallel Claude session that happens to share the
    // project dir, leaking that run's context-window stats into
    // our fresh-pair mobile UI.
    const files = entries
      .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
      .map(e => {
        try {
          const stat = fs.statSync(path.join(dir, e.name));
          return { name: e.name, mtime: stat.mtimeMs, birthtime: stat.birthtimeMs };
        }
        catch { return { name: e.name, mtime: 0, birthtime: 0 }; }
      })
      .filter(f => f.birthtime >= cutoff)
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return null;

    // Determine which file to read. When `currentConversationId`
    // is set, trust it directly (it was set via the same birthtime-
    // filtered detect, the resume_session command, or an explicit
    // /cost output extraction). Otherwise fall back to the freshest
    // newly-created JSONL.
    const targetFile = this.currentConversationId
      ? `${this.currentConversationId}.jsonl`
      : files[0].name;

    if (!files.some(f => f.name === targetFile)) return null;

    return this.extractUsageFromFile(path.join(dir, targetFile));
  }

  private extractUsageFromFile(filePath: string): ContextUsage | null {
    let raw: string;
    try { raw = fs.readFileSync(filePath, 'utf8'); }
    catch { return null; }

    let lastUsage: Record<string, number> | null = null;
    let lastModel: string | null = null;

    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record['type'] === 'assistant') {
          const msg = record['message'] as Record<string, unknown> | undefined;
          // Skip synthetic messages (all-zero usage, not real API responses)
          if (msg?.['model'] === '<synthetic>') continue;
          const usage = msg?.['usage'] as Record<string, number> | undefined;
          if (usage && (usage['input_tokens'] !== undefined || usage['prompt_tokens'] !== undefined)) {
            lastUsage = usage;
          }
          if (msg?.['model']) lastModel = msg['model'] as string;
        }
      } catch { /* skip malformed */ }
    }

    const total = getContextWindow(lastModel);

    if (!lastUsage) {
      // No usage data yet but we may have detected the model (e.g. rate-limited session)
      if (!lastModel) return null;
      return { used: 0, total, percent: 0, model: lastModel, outputTokens: 0, cacheReadTokens: 0 };
    }

    const inputTokens = (lastUsage['input_tokens'] ?? lastUsage['prompt_tokens'] ?? 0)
      + (lastUsage['cache_read_input_tokens'] ?? 0)
      + (lastUsage['cache_creation_input_tokens'] ?? 0);
    const outputTokens = lastUsage['output_tokens'] ?? lastUsage['completion_tokens'] ?? 0;
    const percent = Math.min(100, Math.round((inputTokens / total) * 100));

    return { used: inputTokens, total, percent, model: lastModel, outputTokens, cacheReadTokens: lastUsage['cache_read_input_tokens'] ?? 0 };
  }

  /**
   * Estimate the API cost for the current month in the current project directory.
   * Scans only the JSONL files for this project (cwd), so the value reflects
   * usage from the active Claude Code session rather than the entire machine.
   */
  getMonthlyEstimatedCost(): number {
    const projectDir = this.projectDir;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthStartIso = monthStart.toISOString();
    const monthStartMs = monthStart.getTime();
    let totalCost = 0;

    let files: string[];
    try {
      files = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .filter(f => {
          // Pre-filter: skip files not modified this month
          try { return fs.statSync(path.join(projectDir, f)).mtimeMs >= monthStartMs; }
          catch { return false; }
        });
    } catch { return 0; }

    for (const file of files) {
      let raw: string;
      try { raw = fs.readFileSync(path.join(projectDir, file), 'utf8'); }
      catch { continue; }

      for (const line of raw.split('\n').filter(Boolean)) {
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          if (record['type'] !== 'assistant') continue;

          // Filter by message timestamp — only count current month
          const timestamp = record['timestamp'] as string | undefined;
          if (timestamp && timestamp < monthStartIso) continue;

          const msg = record['message'] as Record<string, unknown> | undefined;
          if (!msg || msg['model'] === '<synthetic>') continue;
          const model = (msg['model'] as string) || '';
          const usage = msg['usage'] as Record<string, number> | undefined;
          if (!usage) continue;

          const pricing = getPricing(model);
          const input = usage['input_tokens'] ?? 0;
          const output = usage['output_tokens'] ?? 0;
          const cacheRead = usage['cache_read_input_tokens'] ?? 0;
          const cacheWrite = usage['cache_creation_input_tokens'] ?? 0;

          totalCost += (input / 1_000_000) * pricing.input
            + (output / 1_000_000) * pricing.output
            + (cacheRead / 1_000_000) * pricing.cacheRead
            + (cacheWrite / 1_000_000) * pricing.cacheWrite;
        } catch { /* skip */ }
      }
    }

    return Math.round(totalCost * 100) / 100;
  }

  /**
   * Push the active agent's resumable-sessions list to the backend.
   * Delegates the per-agent JSONL/rollout walk to
   * `runtime.listResumableSessions(cwd)` so each agent reads its own
   * on-disk format (Claude's JSONL files vs Codex's date-bucketed
   * rollouts). Strategies that don't yet expose the helper (Cursor,
   * Aider) cause this to no-op — the Conversations sheet on mobile
   * just shows the empty state for those agents until each one's
   * `listResumableSessions` lands.
   *
   * The push body now includes `agentId` so the backend keys by
   * (pluginId, agentId). Old CLI clients that omit `agentId` continue
   * to land in the `claude-code` slot via the backend's default.
   *
   * Called once ~2 s after the agent spawns (non-blocking).
   */
  async load(): Promise<void> {
    if (!this.runtime.listResumableSessions) {
      return; // Strategy hasn't opted in to per-agent listing yet.
    }
    const sessions = this.runtime.listResumableSessions(this.cwd);
    if (sessions.length === 0) return;
    await post(
      '/api/sessions/list',
      {
        pluginId: this.pluginId,
        agentId: this.runtime.id,
        sessions,
      },
      this.pluginAuthToken,
    );
  }

  /**
   * Read a specific session's full conversation and POST it to the API in batches.
   * Batching avoids Vercel's 4.5 MB body limit for long sessions.
   * Every batch MUST be confirmed (2xx) before proceeding — retries with
   * exponential backoff (500 ms → 1 s → 2 s → 4 s → 8 s). Throws if a batch
   * still fails after all attempts so callers skip newTurnResume instead of
   * showing an empty conversation.
   */
  /**
   * Resolve the on-disk transcript file for a conversation, agent-aware.
   *
   * Claude stores `<projectDir>/<sessionId>.jsonl`. Other agents name the
   * file differently and key the session id INSIDE it (Codex rollouts), so
   * when the strategy exposes `resolveHistoryFile` we defer to it. Returns
   * null when no transcript exists for this session yet.
   */
  private resolveConversationFile(sessionId: string): string | null {
    if (this.runtime.resolveHistoryFile) {
      return this.runtime.resolveHistoryFile(this.cwd, sessionId);
    }
    return path.join(this.projectDir, `${sessionId}.jsonl`);
  }

  /**
   * Parse a conversation's messages from disk, agent-aware. Claude uses the
   * service's own JSONL parser (unchanged); agents with a custom on-disk
   * layout parse via their strategy's {@link RuntimeStrategy.parseHistoryFile}
   * (e.g. Codex rollouts), mapping the shared NormalizedMessage shape onto our
   * wire shape and dropping `system` rows (the conversation view renders only
   * user/agent). Returns [] when the file is missing/unreadable — same
   * convention as parseJsonl.
   */
  private readConversation(sessionId: string): ClaudeHistoryMessage[] {
    if (this.runtime.resolveHistoryFile) {
      const filePath = this.runtime.resolveHistoryFile(this.cwd, sessionId);
      if (!filePath) return [];
      let parsed: NormalizedMessage[];
      try {
        parsed = this.runtime.parseHistoryFile(filePath);
      } catch (err) {
        log.warn('history:readConversation', `parseHistoryFile failed for ${filePath}`, err);
        return [];
      }
      return parsed
        .filter(
          (m): m is NormalizedMessage & { role: 'user' | 'agent' } =>
            m.role === 'user' || m.role === 'agent',
        )
        .map((m) => {
          // NormalizedMessage carries an ISO timestamp; our wire shape (and
          // the Claude path the backend already ingests) uses epoch ms.
          const ms = new Date(m.timestamp).getTime();
          return {
            id: m.id,
            role: m.role,
            text: m.text,
            timestamp: Number.isFinite(ms) ? ms : Date.now(),
          };
        });
    }
    return parseJsonl(path.join(this.projectDir, `${sessionId}.jsonl`));
  }

  async loadConversation(sessionId: string): Promise<void> {
    const messages = this.readConversation(sessionId);
    if (messages.length === 0) return;

    const totalBatches = Math.ceil(messages.length / CONVERSATION_BATCH_SIZE);
    const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000];

    for (let i = 0; i < totalBatches; i++) {
      const batch = messages.slice(i * CONVERSATION_BATCH_SIZE, (i + 1) * CONVERSATION_BATCH_SIZE);
      const body = {
        pluginId: this.pluginId,
        // `agentId` keys the backend's per-agent conversation cache.
        // Older backends that don't recognise the field silently
        // ignore it and default to `claude-code` server-side — same
        // outcome as before the per-agent split.
        agentId: this.runtime.id,
        sessionId,
        messages: batch,
        batchIndex: i,
        totalBatches,
      };

      let ok = await post('/api/sessions/conversation', body, this.pluginAuthToken);
      for (let attempt = 0; !ok && attempt < RETRY_DELAYS.length; attempt++) {
        await new Promise<void>((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        ok = await post('/api/sessions/conversation', body, this.pluginAuthToken);
      }

      if (!ok) {
        throw new Error(`Failed to upload conversation batch ${i + 1}/${totalBatches} after all retries`);
      }
    }
    // Mark the last message as the high-water mark so subsequent
    // `uploadDelta()` calls only ship the tail.
    const last = messages[messages.length - 1];
    if (last) this.lastUploadedUuid.set(sessionId, last.id);
  }

  /** Per-session JSONL mtime at the last upload — gates {@link uploadConversationIfChanged}. */
  private readonly lastTranscriptMtimeMs = new Map<string, number>();

  /** Wall-clock of the last upload per session — drives the periodic
   *  re-baseline below. */
  private readonly lastUploadWallMs = new Map<string, number>();

  /** The backend stores the conversation with a bounded TTL (24 h,
   *  `WS_SESSION_TTL`). An IDLE session's JSONL never changes, so a pure
   *  mtime gate would never re-ship and the backend copy would expire —
   *  every later `get_conversation` → GET then returns EMPTY forever (the
   *  2026-07-16 "la sesión no carga" regression, second occurrence: the
   *  first fix pushed at session START but nothing refreshed an idle
   *  session past the TTL). Re-baseline at half the backend TTL so the
   *  stored copy can never lapse while the session lives. */
  private static readonly REBASELINE_INTERVAL_MS = 12 * 60 * 60 * 1000;

  /**
   * Upload a session's transcript when its JSONL changed since the last upload.
   * Scales to long/heavy conversations: the ACP `get_conversation` handler is
   * polled (~20 s) and a conversation can grow to many MB, so this must never
   * re-ship the whole file each tick. Two guards:
   *   1. a cheap `stat` mtime short-circuits unchanged files (zero work on a
   *      poll with no new turn);
   *   2. on a real change, ship the FIRST upload as a batched full baseline,
   *      then only the DELTA (messages added since our high-water mark) — O(new
   *      messages), not O(full transcript). A 5 MB / 500-message conversation
   *      re-ships just the latest turn, not the 5 MB, on every subsequent turn.
   * Pinned to the explicit ACP `sessionId` (never the mtime-based
   * `detectCurrentConversation`, which can pick a stray parallel JSONL — the
   * "7 JSONLs" case). Returns true when it uploaded; false when nothing changed
   * or no transcript exists yet (not an error).
   */
  async uploadConversationIfChanged(sessionId: string): Promise<boolean> {
    const filePath = this.resolveConversationFile(sessionId);
    if (!filePath) return false; // no transcript on disk for this session yet
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      return false; // no transcript yet
    }
    // Periodic re-baseline: past half the backend's conversation TTL, the
    // stored copy may be about to (or already did) expire — re-ship the
    // FULL baseline even when the mtime is unchanged. A delta over an
    // expired copy would persist only the tail, so this must reset the
    // high-water mark, never go through uploadDelta.
    const now = Date.now();
    const staleBaseline =
      now - (this.lastUploadWallMs.get(sessionId) ?? 0) >
      HistoryService.REBASELINE_INTERVAL_MS;
    if (!staleBaseline && this.lastTranscriptMtimeMs.get(sessionId) === mtimeMs) {
      return false;
    }
    if (staleBaseline) this.lastUploadedUuid.delete(sessionId);
    // First upload for this session → batched full baseline (also sets the
    // high-water mark). Afterwards → incremental delta only.
    let uploaded: boolean;
    if (this.lastUploadedUuid.has(sessionId)) {
      uploaded = (await this.uploadDelta(sessionId)) > 0;
    } else {
      await this.loadConversation(sessionId);
      uploaded = true;
    }
    this.lastTranscriptMtimeMs.set(sessionId, mtimeMs);
    this.lastUploadWallMs.set(sessionId, now);
    return uploaded;
  }

  /**
   * Incremental upload — ships only the messages added since the last
   * `loadConversation` / `uploadDelta` call for this conversation.
   * Used by `onTurnComplete` after every turn so the backend's
   * conversation table stays fresh enough for the SSE consumers
   * (mobile + web dashboard) to fetch the canonical markdown via
   * `?last=N` and replace the streaming-from-PTY approximation —
   * which lacks the markdown ``` fences the parser needs to surface
   * the rich CodeBlock / DiffBlock / etc. components.
   *
   * Posts under `mode: 'append'` so the server merges by uuid
   * instead of replacing the full conversation. Idempotent — if
   * called twice in a row the second call sees zero new messages
   * and is a no-op.
   *
   * Returns the number of messages uploaded (0 means nothing new).
   */
  async uploadDelta(explicitSessionId?: string): Promise<number> {
    // Lazy-detect the conversation id when uploadDelta is the first
    // path that needs it. The eager detect at start.ts T+2000ms
    // misses the case where claude takes longer than 2s to spawn
    // (e.g. codespace cold start that triggers Claude's lazy
    // node-16 download — claude doesn't start writing the JSONL
    // until ~30-60s in). Without this fallback the conversationId
    // stays null forever, every uploadDelta early-bails, the
    // server never sees the canonical JSONL with markdown fences,
    // and mobile/web stay stuck on the streaming-text approximation
    // (no `\`\`\`` fences → CodeBlock never renders, code shows as
    // plain monospace with template-literal backticks misparsed
    // as inline-code pills).
    // Prefer an EXPLICIT (ACP) session id when the caller has one — pinned,
    // never mtime-guessed (avoids picking a stray parallel JSONL). Fall back to
    // the lazily-detected current conversation for the legacy/PTY callers.
    let sessionId = explicitSessionId ?? this.currentConversationId;
    if (!sessionId) {
      this.detectCurrentConversation();
      sessionId = this.currentConversationId;
      if (!sessionId) return 0;
    }
    const messages = this.readConversation(sessionId);
    if (messages.length === 0) return 0;

    const marker = this.lastUploadedUuid.get(sessionId);
    let newMessages = messages;
    if (marker) {
      const idx = messages.findIndex((m) => m.id === marker);
      if (idx >= 0) {
        newMessages = messages.slice(idx + 1);
      }
      // If marker not found (JSONL was rewritten by Claude or
      // session resume rewrote uuids), fall back to uploading all
      // messages in append mode — server-side dedup-by-uuid keeps
      // it idempotent so the only cost is bandwidth on a recovery
      // path that should be rare.
    }
    if (newMessages.length === 0) return 0;

    const body = {
      pluginId: this.pluginId,
      agentId: this.runtime.id,
      sessionId,
      messages: newMessages,
      mode: 'append' as const,
    };

    const ok = await post('/api/sessions/conversation', body, this.pluginAuthToken);
    if (ok) {
      const last = newMessages[newMessages.length - 1];
      this.lastUploadedUuid.set(sessionId, last.id);
      return newMessages.length;
    }
    // Soft failure — keep the marker as it was so the next call
    // re-tries the same delta. Don't throw; the caller is fire-and-
    // forget and the streamed approximation already showed in the
    // UI, the canonical refresh is a polish.
    return 0;
  }
}
