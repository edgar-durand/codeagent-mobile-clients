/**
 * Tiny HTTP publisher for the ACP runner.
 *
 * Same wire shape + endpoints as the legacy {@link
 * StreamingEmitterService} (`/api/sessions/:id/streaming-chunk` +
 * `/api/sessions/:id/awaiting-answer` + the pending-answer poll),
 * just extracted so the ACP path doesn't have to drag the whole
 * PTY-parsing class. Behaviour-equivalent — every change here is a
 * fix-once-fix-both candidate to mirror on the legacy emitter.
 *
 * Why duplicate the small surface instead of refactoring the
 * StreamingEmitterService: the PTY emitter owns a lot of state
 * (renderToLines accumulator, selector dedup, tick loop) that the
 * ACP path has no need for. Splitting the publisher into its own
 * file keeps each runner's I/O concerns minimal and testable.
 */

import { _transport } from '../../services/streaming/transport';
import { resolveApiBaseUrl } from '@codeagent/shared';
import type {
  AnswerResolvedEvent,
  AwaitingAnswerEvent,
  StreamingChunkEvent,
} from '@codeagent/shared';
import { log } from '../../services/logger';

export interface AcpPublisherOptions {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  /** Override the API base URL (defaults to env / prod). Used by tests. */
  apiBaseUrl?: string;
}

export class AcpPublisher {
  private readonly apiBase: string;
  private readonly headers: Record<string, string>;

  constructor(private readonly opts: AcpPublisherOptions) {
    this.apiBase = opts.apiBaseUrl ?? resolveApiBaseUrl();
    this.headers = {
      'Content-Type': 'application/json',
      'X-Codeam-Protocol-Version': '2.0.0',
      'X-Plugin-Auth-Token': opts.pluginAuthToken,
    };
  }

  /**
   * Wrap the event with `sessionId` + `pluginId` at the top level.
   * The backend's `PluginAuthGuard` reads both fields from the JSON
   * body even when `X-Plugin-Auth-Token` is set on the header and
   * `:sessionId` is on the URL path. Without the body fields it
   * rejects every POST with `PLUGIN_TOKEN_REQUIRED` — same shape the
   * legacy `streaming-emitter.service.ts` `postWithRetries` uses.
   */
  private envelope(event: StreamingChunkEvent | AwaitingAnswerEvent): string {
    return JSON.stringify({
      sessionId: this.opts.sessionId,
      pluginId: this.opts.pluginId,
      ...event,
    });
  }

  /**
   * Fire-and-forget chunk POST. The backend's per-user SSE bus
   * forwards each chunk to mobile/landing within ~20 ms (PRO) /
   * ~80 ms (FREE). Errors are logged but never thrown — a missed
   * chunk shouldn't bring down the whole session.
   */
  async publishChunk(event: StreamingChunkEvent): Promise<void> {
    const url = `${this.apiBase}/api/sessions/${encodeURIComponent(this.opts.sessionId)}/streaming-chunk`;
    try {
      const { statusCode, body } = await _transport.post(
        url,
        this.headers,
        this.envelope(event),
      );
      if (statusCode < 200 || statusCode >= 300) {
        log.warn('acpPublisher', `chunk status=${statusCode} body=${body.slice(0, 200)}`);
      }
    } catch (err) {
      log.trace('acpPublisher', 'chunk post failed', err);
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
      const { statusCode, body } = await _transport.post(
        url,
        this.headers,
        this.envelope(event),
      );
      if (statusCode < 200 || statusCode >= 300) {
        log.warn('acpPublisher', `awaiting-answer status=${statusCode} body=${body.slice(0, 200)}`);
      }
    } catch (err) {
      log.trace('acpPublisher', 'awaiting-answer post failed', err);
    }
  }

  /**
   * Drain the pending-answer endpoint. Returns the resolved answer
   * when the user has replied, `null` otherwise. The caller polls
   * this on a 1.5 s cadence (same as the legacy emitter) until a
   * non-null result lands.
   */
  async pollPendingAnswer(questionId: string): Promise<AnswerResolvedEvent | null> {
    const url =
      `${this.apiBase}/api/sessions/${encodeURIComponent(this.opts.sessionId)}/pending-answer` +
      `?questionId=${encodeURIComponent(questionId)}` +
      `&pluginId=${encodeURIComponent(this.opts.pluginId)}`;
    try {
      const { statusCode, body } = await _transport.get(url, this.headers);
      if (statusCode === 204 || statusCode === 404) return null;
      if (statusCode < 200 || statusCode >= 300) {
        log.warn('acpPublisher', `pending-answer status=${statusCode} body=${body.slice(0, 200)}`);
        return null;
      }
      return parsePendingAnswerResponse(body, questionId);
    } catch (err) {
      log.trace('acpPublisher', 'pending-answer poll failed', err);
      return null;
    }
  }
}

/**
 * Parse the `GET /api/sessions/:id/pending-answer` envelope and
 * confirm the returned questionId matches the caller's. The
 * backend wraps the resource in `{ data: { … } }` (NestJS
 * standard envelope) but legacy paths sometimes return the bare
 * shape — accept both.
 *
 * Exported so the unit tests can assert envelope handling without
 * standing up an HTTP layer.
 */
export function parsePendingAnswerResponse(
  body: string,
  questionId: string,
): AnswerResolvedEvent | null {
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  const candidate =
    root.data && typeof root.data === 'object'
      ? (root.data as Record<string, unknown>)
      : root;
  const qid = candidate.questionId;
  const answer = candidate.answer;
  const optionIndex = candidate.optionIndex;
  if (typeof qid !== 'string' || qid !== questionId) return null;
  if (typeof answer !== 'string') return null;
  const result: AnswerResolvedEvent = { questionId: qid, answer };
  if (typeof optionIndex === 'number' && Number.isInteger(optionIndex)) {
    result.optionIndex = optionIndex;
  }
  return result;
}
