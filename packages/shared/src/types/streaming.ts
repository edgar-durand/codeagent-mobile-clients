/**
 * Wire-shape types for the CLI / IDE-plugin → backend Epic C streaming
 * endpoints. The CLI parses Claude's (or Codex's) PTY output into a
 * stream of discriminated chunks and pushes each one to the backend, so
 * the mobile client can render an in-progress agent turn token-by-token
 * instead of waiting for the entire turn to finalise.
 *
 *   - `POST /api/sessions/:id/streaming-chunk` — body is
 *     {@link StreamingChunkEvent}. Fires an SSE delta downstream.
 *   - `POST /api/sessions/:id/awaiting-answer` — body is
 *     {@link AwaitingAnswerEvent}. Pauses the turn on the mobile side
 *     and prompts the user for a reply. Stored in Redis with a 5 min TTL.
 *   - Answer channel: backend publishes user replies on the Redis
 *     channel `session:${sessionId}:answers` with the payload shape
 *     {@link AnswerResolvedEvent}. The CLI polls
 *     `GET /api/sessions/:id/pending-answer` to drain it (the polling
 *     interval is 1.5 s — short enough to feel instant, long enough to
 *     stay well under any sane rate limit).
 *
 * These mirror the backend NestJS DTOs at:
 *   apps/api-v2/src/sessions/dto/streaming-chunk.dto.ts
 *   apps/api-v2/src/sessions/dto/awaiting-answer.dto.ts
 *   apps/api-v2/src/sessions/dto/answer-resolved.dto.ts
 *
 * They are wire-only — no class-validator decorators, no runtime
 * coercion. The producer constructs them in TypeScript and serialises
 * directly to JSON. The backend re-validates on its side.
 */

/**
 * Logical kind of an Epic C streaming chunk.
 *
 * - `text`        — agent prose (the conversational reply the user sees).
 * - `thinking`    — Claude's "(thinking)" / "+ Puttering…" frame between
 *                   the prompt and the answer.
 * - `tool_use`    — a tool call (Read / Edit / Bash / Search / …) the
 *                   agent invoked.
 * - `tool_result` — the result body of the prior tool call (typically
 *                   the `└ …` continuation line in Claude's TUI).
 */
export type StreamingChunkKind = 'text' | 'thinking' | 'tool_use' | 'tool_result';

/**
 * Body for `POST /api/sessions/:id/streaming-chunk`.
 *
 * `chunkId` is stable across continuation pushes for the same logical
 * chunk (so the backend can splice deltas), and changes when the
 * producer flips `kind` or finalises the chunk. `isFinal: true` marks
 * the last push for this `chunkId`; the next emission opens a fresh
 * chunkId.
 */
export interface StreamingChunkEvent {
  chunkId: string;
  kind: StreamingChunkKind;
  content: string;
  isFinal: boolean;
}

/**
 * Body for `POST /api/sessions/:id/awaiting-answer`.
 *
 * `prompt` is the question text the agent rendered (free-form). When
 * the agent presented a multiple-choice selector, `options` is the
 * ordered list of choices the user can pick. `questionId` is the
 * producer-generated UUID the backend echoes back through the answer
 * channel so the CLI can correlate the user's reply with the prompt.
 */
export interface AwaitingAnswerEvent {
  questionId: string;
  /**
   * Question text for clients that render the prompt header.
   * `content` is a compatibility alias for older output-chunk
   * renderers that key selector prompts off the chunk content field.
   */
  prompt: string;
  content?: string;
  /**
   * Full context captured from the CLI prompt, including wrapped
   * option details when the terminal rendered additional explanation
   * below a choice label.
   */
  promptContext?: string;
  options?: string[];
  optionDescriptions?: string[];
  currentIndex?: number;
}

/**
 * Payload published on the Redis `session:${sessionId}:answers`
 * channel — and also the shape returned by the polling fallback
 * `GET /api/sessions/:id/pending-answer` (wrapped in `{ data: … }` by
 * the backend's standard envelope).
 *
 * For free-form prompts `answer` is the user's typed text. For a
 * selector prompt, the backend forwards the chosen option label as
 * `answer` and additionally sets `optionIndex` (0-based) so the
 * producer can drive arrow-key navigation in a React Ink selector
 * without re-resolving the label.
 */
export interface AnswerResolvedEvent {
  questionId: string;
  answer: string;
  optionIndex?: number;
}
