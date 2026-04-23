import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { getContextWindow, getPricing } from '@codeagent/shared';

const API_BASE = process.env.CODEAM_API_URL ?? 'https://codeagent-mobile-api.vercel.app';

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

/** Encode a cwd path to the Claude project directory name (/ → -). */
function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
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

const CONVERSATION_BATCH_SIZE = 30;

/** Parse a JSONL session file into a list of ChatMessages (user + assistant only). */
function parseJsonl(filePath: string): ClaudeHistoryMessage[] {
  const messages: ClaudeHistoryMessage[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return messages;
  }
  const lines = raw.split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const type = record['type'] as string | undefined;
      const msg = record['message'] as Record<string, unknown> | undefined;
      const ts = record['timestamp'];
      const timestamp =
        typeof ts === 'string' ? new Date(ts).getTime() : typeof ts === 'number' ? ts : Date.now();
      const uuid =
        (record['uuid'] as string | undefined) ?? `${Date.now()}-${Math.random()}`;

      // isMeta=true marks injected context (skills, hooks, system prompts) — skip
      if (record['isMeta']) continue;

      if (type === 'user' && msg) {
        const text = extractText(msg['content']).trim();
        if (text) messages.push({ id: uuid, role: 'user', text, timestamp });
      } else if (type === 'assistant' && msg) {
        const text = extractText(msg['content']).trim();
        if (text) messages.push({ id: uuid, role: 'agent', text, timestamp });
      }
    } catch {
      // malformed line — skip
    }
  }
  return messages;
}

/** POST JSON to the API. Returns true on 2xx, false on error/timeout/non-2xx. */
function post(endpoint: string, body: Record<string, unknown>): Promise<boolean> {
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
        },
        timeout: 15000,
      },
      (res) => {
        res.resume(); // drain response body
        resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
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

  constructor(
    private readonly pluginId: string,
    private readonly cwd: string,
  ) {}

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
    return path.join(os.homedir(), '.claude', 'projects', encodeCwd(this.cwd));
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
  async waitForNewUserMessage(previousCount: number, timeoutMs = 4000): Promise<string | null> {
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

  /** Detect the active conversation by finding the most recently modified JSONL file */
  detectCurrentConversation(): void {
    const dir = this.projectDir;
    try {
      const files = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
        .map(e => {
          try { return { name: e.name, mtime: fs.statSync(path.join(dir, e.name)).mtimeMs }; }
          catch { return { name: e.name, mtime: 0 }; }
        })
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) {
        this.currentConversationId = path.basename(files[0].name, '.jsonl');
      }
    } catch { /* silent */ }
  }

  /** Extract conversation ID from Claude output (e.g., from session resume messages) */
  tryExtractConversationIdFromOutput(output: string): void {
    // Pattern: "Resuming session: <uuid>" or similar messages
    const patterns = [
      /Resuming session[:\s]+([a-f0-9-]{36})/i,
      /session[:\s]+([a-f0-9-]{36})/i,
      /conversation[:\s]+([a-f0-9-]{36})/i,
    ];
    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match) {
        this.currentConversationId = match[1];
        return;
      }
    }
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

    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return null; }

    // Get all JSONL files sorted by modification time (most recent first)
    const files = entries
      .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
      .map(e => {
        try { return { name: e.name, mtime: fs.statSync(path.join(dir, e.name)).mtimeMs }; }
        catch { return { name: e.name, mtime: 0 }; }
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return null;

    // Determine which file to read
    const targetFile = this.currentConversationId
      ? `${this.currentConversationId}.jsonl`
      : files[0].name; // most recent if no conversation set

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
   * Read session list from disk and POST it to the API.
   * Called once ~2 s after Claude spawns (non-blocking).
   */
  async load(): Promise<void> {
    const dir = this.projectDir;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // no sessions dir — skip silently
    }

    const sessions: ClaudeSession[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const id = path.basename(entry.name, '.jsonl');
      const filePath = path.join(dir, entry.name);
      let mtime = Date.now();
      try {
        mtime = fs.statSync(filePath).mtimeMs;
      } catch {
        /* ignore */
      }

      // Get summary from first user message
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
            /* skip */
          }
        }
      } catch {
        /* skip */
      }

      if (summary) sessions.push({ id, summary, timestamp: mtime });
    }

    if (sessions.length === 0) return;

    // Sort newest first
    sessions.sort((a, b) => b.timestamp - a.timestamp);

    await post('/api/sessions/claude-sessions', { pluginId: this.pluginId, sessions });
  }

  /**
   * Read a specific session's full conversation and POST it to the API in batches.
   * Batching avoids Vercel's 4.5 MB body limit for long sessions.
   * Every batch MUST be confirmed (2xx) before proceeding — retries with
   * exponential backoff (500 ms → 1 s → 2 s → 4 s → 8 s). Throws if a batch
   * still fails after all attempts so callers skip newTurnResume instead of
   * showing an empty conversation.
   */
  async loadConversation(sessionId: string): Promise<void> {
    const filePath = path.join(this.projectDir, `${sessionId}.jsonl`);
    const messages = parseJsonl(filePath);
    if (messages.length === 0) return;

    const totalBatches = Math.ceil(messages.length / CONVERSATION_BATCH_SIZE);
    const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000];

    for (let i = 0; i < totalBatches; i++) {
      const batch = messages.slice(i * CONVERSATION_BATCH_SIZE, (i + 1) * CONVERSATION_BATCH_SIZE);
      const body = { pluginId: this.pluginId, sessionId, messages: batch, batchIndex: i, totalBatches };

      let ok = await post('/api/sessions/claude-conversation', body);
      for (let attempt = 0; !ok && attempt < RETRY_DELAYS.length; attempt++) {
        await new Promise<void>((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        ok = await post('/api/sessions/claude-conversation', body);
      }

      if (!ok) {
        throw new Error(`Failed to upload conversation batch ${i + 1}/${totalBatches} after all retries`);
      }
    }
  }
}
