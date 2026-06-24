/**
 * HTTP publisher for the ACP runner.
 *
 * Posts to TWO backend endpoints:
 *
 *   1. **`/api/commands/output`** — the legacy chat-render pipeline
 *      mobile actually consumes for "Thinking…" → reply → done. Same
 *      pipe `ChunkEmitter` (legacy PTY path) uses; the only
 *      destination that drives the chat surface. Wire shape:
 *      `{ sessionId, pluginId, type, content?, done? }` where `type`
 *      is `'clear' | 'new_turn' | 'text' | …`. NO `chunkId`,
 *      `kind`, or `isFinal` fields — those are part of the
 *      *streaming-chunk* feed (#2 below) which targets a different
 *      mobile surface.
 *
 *   2. **`/api/sessions/:id/awaiting-answer`** — the pending-answer
 *      sheet (permission requests, list selectors). Still uses the
 *      sessions feed because that's where the mobile awaiting-answer
 *      poll listens.
 *
 * We INTENTIONALLY skipped `/api/sessions/:id/streaming-chunk` in
 * the v2.27.8 round of fixes: smoke testing proved chunks landed
 * with 2xx but never reached the chat. Reading the legacy code
 * showed the chat pipe is `/api/commands/output`; the streaming-chunk
 * feed is Epic C internal-task-state, not the chat surface.
 */

import { _transport } from '../../services/streaming/transport';
import { resolveApiBaseUrl } from '@codeagent/shared';
import type { AwaitingAnswerEvent, StreamingChunkEvent } from '@codeagent/shared';
import { log } from '../../services/logger';

export interface AcpPublisherOptions {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  /** Override the API base URL (defaults to env / prod). Used by tests. */
  apiBaseUrl?: string;
  /**
   * Fetch a fresh `X-Plugin-Auth-Token`. Called when an authed POST
   * comes back 401/403 — the baked-in token went stale because the
   * backend's JWT_SECRET rotated (a deploy) or the session re-paired.
   * Returns null when no fresh token can be obtained (offline / not
   * paired), in which case the POST is NOT retried.
   */
  refreshAuthToken?: () => Promise<string | null>;
}

export class AcpPublisher {
  private readonly apiBase: string;
  private token: string;

  constructor(private readonly opts: AcpPublisherOptions) {
    this.apiBase = opts.apiBaseUrl ?? resolveApiBaseUrl();
    this.token = opts.pluginAuthToken;
  }

  private authHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Codeam-Protocol-Version': '2.0.0',
      'X-Plugin-Auth-Token': this.token,
    };
  }

  /**
   * POST with the current plugin-auth token. On a 401/403 the token is
   * stale (JWT_SECRET rotated on deploy, or the session re-paired);
   * refresh it via the injected callback and retry ONCE. Any other
   * status (or a refresh that yields no token) returns the first
   * response unchanged — callers log non-2xx but never throw.
   */
  private async postWithReauth(
    url: string,
    payload: string,
  ): Promise<{ statusCode: number; body: string }> {
    const first = await _transport.post(url, this.authHeaders(), payload);
    if (first.statusCode !== 401 && first.statusCode !== 403) return first;
    if (!this.opts.refreshAuthToken) return first;
    const fresh = await this.opts.refreshAuthToken();
    if (!fresh) return first;
    this.token = fresh;
    log.info('acpPublisher', `plugin-auth token refreshed after ${first.statusCode}; retrying POST`);
    return _transport.post(url, this.authHeaders(), payload);
  }

  /**
   * Wrap the body with `sessionId` + `pluginId` at the top level.
   * The backend's `PluginAuthGuard` reads both fields from the JSON
   * body even when `X-Plugin-Auth-Token` is set on the header.
   */
  private envelope(body: Record<string, unknown>): string {
    return JSON.stringify({
      sessionId: this.opts.sessionId,
      pluginId: this.opts.pluginId,
      ...body,
    });
  }

  /**
   * POST one event to the legacy chat-render pipeline at
   * `/api/commands/output`. Mobile reads this feed for the chat
   * surface — every "Thinking…" → reply → done bubble flows through
   * here. Accepts arbitrary body shapes (the legacy emitter is a
   * thin pipe; mobile branches on `type`):
   *
   *   { type: 'clear' }                              wipe screen
   *   { type: 'new_turn', done: false }              "Agent is typing…"
   *   { type: 'text', content: '…', done: false }    streaming delta
   *   { type: 'text', content: '…', done: true }     turn complete
   *
   * Errors are logged but never thrown — a missed chunk shouldn't
   * bring down the whole session.
   */
  async publishOutput(body: Record<string, unknown>): Promise<void> {
    const url = `${this.apiBase}/api/commands/output`;
    try {
      const { statusCode, body: resBody } = await this.postWithReauth(url, this.envelope(body));
      if (statusCode < 200 || statusCode >= 300) {
        log.warn(
          'acpPublisher',
          `output type=${String(body.type)} done=${body.done === true} status=${statusCode} body=${resBody.slice(0, 200)} | sentSessionId=${this.opts.sessionId} sentPluginId=${this.opts.pluginId} tokenLen=${this.token.length} tokenHead=${this.token.slice(0, 12)} tokenTail=${this.token.slice(-8)}`,
        );
      }
    } catch (err) {
      log.warn(
        'acpPublisher',
        `output type=${String(body.type)} post failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Publish an awaiting-answer event so the mobile renders the
   * pending-prompt sheet. The CLI follows up with
   * {@link pollPendingAnswer} until the user replies (or the
   * 5 min Redis TTL expires upstream).
   */
  async publishAwaitingAnswer(event: AwaitingAnswerEvent): Promise<void> {
    const url = `${this.apiBase}/api/sessions/${encodeURIComponent(this.opts.sessionId)}/awaiting-answer`;
    try {
      const { statusCode, body } = await this.postWithReauth(
        url,
        this.envelope(event as unknown as Record<string, unknown>),
      );
      if (statusCode < 200 || statusCode >= 300) {
        log.warn('acpPublisher', `awaiting-answer status=${statusCode} body=${body.slice(0, 200)}`);
      }
    } catch (err) {
      log.trace('acpPublisher', 'awaiting-answer post failed', err);
    }
  }

  /**
   * Push one chunk to the Epic C streaming-chunk feed
   * (`/api/sessions/:id/streaming-chunk`). Mobile's
   * SessionDetailScreen reads these via the per-user SSE bus
   * (`agent_streaming_chunk` variant) and renders dedicated bubbles
   * by `kind`:
   *
   *   - `text`        → normal assistant bubble
   *   - `thinking`    → dimmed "THINKING…" card
   *   - `tool_use`    → purple pill chip with build icon
   *   - `tool_result` → collapsible GlassCard
   *
   * Coalescence is `(sessionId, chunkId)` on the consumer side —
   * successive chunks with the same chunkId concatenate `content`
   * until `isFinal: true` lands. The chat-output pipe
   * ({@link publishOutput}) is independent and carries `type:'text'`
   * for the main chat bubble; this feed is purely additive for the
   * richer SessionDetail surface.
   */
  async publishStreamingChunk(event: StreamingChunkEvent): Promise<void> {
    const url = `${this.apiBase}/api/sessions/${encodeURIComponent(this.opts.sessionId)}/streaming-chunk`;
    try {
      const { statusCode, body } = await this.postWithReauth(
        url,
        this.envelope(event as unknown as Record<string, unknown>),
      );
      if (statusCode < 200 || statusCode >= 300) {
        log.warn(
          'acpPublisher',
          `streaming-chunk status=${statusCode} body=${body.slice(0, 200)}`,
        );
      }
    } catch (err) {
      log.trace('acpPublisher', 'streaming-chunk post failed', err);
    }
  }

  /**
   * Push the list of resumable sessions for `(pluginId, agentId)` so
   * mobile's Conversations sheet's RECENT section can render
   * something. Legacy PTY agents call this from
   * `HistoryService.load()` after scanning `~/.claude/projects/<cwd>/*.jsonl`;
   * ACP agents have no on-disk transcript, so the {@link runner}
   * builds a minimal in-memory `ClaudeSession` (id, summary, ts) and
   * pushes one entry per active ACP conversation.
   *
   * `agentId` is the runtime id (`'claude' | 'codex' | 'gemini'`) —
   * the backend's `pushClaudeSessions` accepts whatever string the
   * CLI sends and persists it under that key; mobile passes the same
   * agentId when fetching, so the storage cell matches.
   */
  async pushSessionList(args: {
    agentId: string;
    sessions: Array<{ id: string; summary: string; timestamp: number }>;
  }): Promise<void> {
    const url = `${this.apiBase}/api/sessions/list`;
    const body = JSON.stringify({
      pluginId: this.opts.pluginId,
      agentId: args.agentId,
      sessions: args.sessions,
    });
    try {
      const { statusCode, body: resBody } = await this.postWithReauth(url, body);
      if (statusCode < 200 || statusCode >= 300) {
        log.warn(
          'acpPublisher',
          `sessions/list status=${statusCode} body=${resBody.slice(0, 200)}`,
        );
      }
    } catch (err) {
      log.trace('acpPublisher', 'sessions/list post failed', err);
    }
  }

  /**
   * Push a conversation's full ordered message history so mobile can
   * render historical bubbles when the user opens the conversation
   * from the RECENT sheet. ACP messages are alternating user/agent
   * turns we accumulate in the runner ({@link AcpHistory}); legacy
   * PTY agents push their parsed JSONL contents through the same
   * endpoint. Backend deduplicates on `id` so re-sending the full
   * list each turn (cheaper than batched deltas for typical chats) is
   * safe + idempotent.
   *
   * `mode: 'replace'` so a re-send overrides any stale persisted
   * version — important for the ACP path because each turn we ship
   * the cumulative messages, not a delta.
   */
  async pushConversation(args: {
    agentId: string;
    sessionId: string;
    messages: Array<{ id: string; role: 'user' | 'agent'; text: string; timestamp: number }>;
  }): Promise<void> {
    const url = `${this.apiBase}/api/sessions/conversation`;
    const body = JSON.stringify({
      pluginId: this.opts.pluginId,
      agentId: args.agentId,
      sessionId: args.sessionId,
      messages: args.messages,
      mode: 'replace',
    });
    try {
      const { statusCode, body: resBody } = await this.postWithReauth(url, body);
      if (statusCode < 200 || statusCode >= 300) {
        log.warn(
          'acpPublisher',
          `sessions/conversation status=${statusCode} body=${resBody.slice(0, 200)}`,
        );
      }
    } catch (err) {
      log.trace('acpPublisher', 'sessions/conversation post failed', err);
    }
  }
}
