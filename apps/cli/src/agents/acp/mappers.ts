/**
 * Pure mappers — ACP wire types → our existing streaming chunk + awaiting-answer shapes.
 *
 * Kept side-effect-free so the unit tests can drive them with
 * captured JSON-RPC payload fixtures without spawning the adapter.
 * The {@link AcpClient} feeds these and the {@link AcpPublisher}
 * sends the results upstream.
 *
 * Why the existing wire model fits without modification: our
 * `StreamingChunkKind` already distinguishes `text | thinking |
 * tool_use | tool_result`, and `AwaitingAnswerEvent` already carries
 * `prompt + options`. ACP's `SessionUpdate` variants slot into those
 * cleanly:
 *
 *     ACP variant                          → our kind
 *     ────────────────────────────────────────────────
 *     agent_message_chunk                   text
 *     agent_thought_chunk                   thinking
 *     tool_call (status pending/in_progress)tool_use
 *     tool_call_update (status completed)   tool_result
 *     tool_call_update (status failed)      tool_result   (prefixed "[failed] ")
 *     user_message_chunk                    (dropped — local echo)
 *     plan / *_update / usage_update        (dropped Phase 1)
 *
 * Mapping a `tool_call` to a chunk requires picking a `chunkId`. ACP
 * gives us a stable `toolCallId` per call — we use it verbatim as
 * the chunkId so a follow-up `tool_call_update` for the same id
 * lands in the same logical bubble on mobile.
 *
 * The mappers return `null` when a variant should be silently
 * dropped — never throw on unknown shapes (forward-compat with
 * future SessionUpdate variants the SDK adds).
 */

import { randomUUID } from 'node:crypto';
import type {
  ContentBlock,
  RequestPermissionRequest,
  SessionNotification,
  TextContent,
  ToolCallContent,
} from '@agentclientprotocol/sdk';
import type {
  AwaitingAnswerEvent,
  StreamingChunkKind,
} from '@codeam/shared';

/**
 * Map one ACP `session/update` notification to the chunk *delta(s)*
 * it implies. Returns an empty array when the variant is
 * informational (plan / usage updates) or a local echo we already
 * render client-side (user_message_chunk).
 *
 * Why deltas (and not full chunks): the wire convention the backend
 * + mobile renderer expect — implemented end-to-end by
 * `streaming-emitter.service.ts` (see its `maybeFlushActive`) — is
 * that every POST under the same `chunkId` carries the **cumulative
 * content** for that chunk, with `isFinal: false` during streaming
 * and `isFinal: true` to mark it complete. Mobile concatenates by
 * (sessionId, chunkId) and stops accumulating once an `isFinal:
 * true` lands.
 *
 * ACP doesn't carry that wire model — each `agent_message_chunk`
 * notification is a discrete text delta and there's no per-chunk
 * "done" signal until the whole prompt turn ends. So the mapper
 * returns deltas and the {@link runner} is responsible for
 * accumulating per chunkId, posting cumulative content with
 * `isFinal: false`, and closing every open chunk with
 * `isFinal: true` when `client.prompt()` resolves.
 */
export interface ChunkDelta {
  chunkId: string;
  kind: StreamingChunkKind;
  /** New bytes to append to whatever the runner has accumulated for
   *  this (chunkId, kind) pair. The runner posts the cumulative
   *  string, not this delta verbatim. */
  delta: string;
}

export function mapSessionUpdate(
  notification: SessionNotification,
): ChunkDelta[] {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = extractText(update.content);
      if (!text) return [];
      return [{ chunkId: messageChunkId(update.messageId), kind: 'text', delta: text }];
    }
    case 'agent_thought_chunk': {
      const text = extractText(update.content);
      if (!text) return [];
      // Distinct chunkId from the SAME message's agent_message_chunk.
      // Claude streams a thought and the reply under one messageId, so
      // sharing the derived chunkId made the chunk "flip" thinking↔text
      // mid-stream. The mobile store latches a chunk's first kind, so
      // the reply text ended up stored as a `thinking` chunk and
      // polluted the live-activity line (it showed the agent's ANSWER
      // where the current thought belongs — "se marea"). Namespacing the
      // thought id keeps the thinking and text streams fully separate.
      return [
        {
          chunkId: `${messageChunkId(update.messageId)}::thought`,
          kind: 'thinking',
          delta: text,
        },
      ];
    }
    case 'tool_call': {
      const summary = describeToolCall(update);
      if (!summary) return [];
      // tool_call carries the full summary up front (no streaming),
      // so emitting a single delta == full content is fine. The
      // runner still posts it as isFinal=false and the prompt-end
      // closer marks it true.
      return [{ chunkId: update.toolCallId, kind: 'tool_use', delta: summary }];
    }
    case 'tool_call_update': {
      // We only emit a `tool_result` once the tool reaches a
      // terminal status; intermediate progress updates would
      // visually thrash the bubble on mobile.
      if (update.status !== 'completed' && update.status !== 'failed') {
        return [];
      }
      const body = describeToolCallUpdate(update);
      if (!body) return [];
      const prefix = update.status === 'failed' ? '[failed] ' : '';
      return [{ chunkId: update.toolCallId, kind: 'tool_result', delta: prefix + body }];
    }
    case 'user_message_chunk':
      // Echo of the user's own prompt — mobile already renders this
      // locally on send. Forwarding would double-bubble.
      return [];
    case 'plan':
    case 'plan_update':
    case 'plan_removed':
    case 'available_commands_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
    case 'usage_update':
      // Informational variants. Phase 2 can surface plan/usage
      // dedicated UI; for Phase 1 the mobile keeps showing the
      // text + tool_use stream only.
      return [];
    default:
      // Forward-compat: a new SDK release may add variants we
      // haven't enumerated yet. Drop silently rather than throw —
      // the worst case is a missing UI affordance for the new
      // variant, not a crashed session.
      return [];
  }
}

/**
 * Map an ACP `session/request_permission` request to our
 * `awaiting-answer` wire shape. Returns the AwaitingAnswerEvent the
 * publisher posts upstream, plus a lookup table the client uses to
 * resolve the user's reply back to one of the original ACP
 * `optionId` values.
 *
 * The lookup is keyed by the user-facing option label (the same
 * string we send to mobile as `options[i]`) because the answer
 * channel echoes the picked label back — see `AnswerResolvedEvent`.
 * Two options sharing the same label collapse to one entry; this is
 * extremely unlikely in practice (adapters render distinct labels)
 * but we drop the second silently rather than throw.
 */
export function mapPermissionRequest(
  request: RequestPermissionRequest,
): {
  event: AwaitingAnswerEvent;
  /** label → original ACP optionId, for resolving the reply back. */
  optionIdByLabel: Record<string, string>;
  /** label → kind, used to log the user's choice category. */
  kindByLabel: Record<string, string>;
} {
  const prompt = describeToolCall(request.toolCall) ?? 'The agent requested permission to continue.';
  const optionIdByLabel: Record<string, string> = {};
  const kindByLabel: Record<string, string> = {};
  const labels: string[] = [];
  for (const opt of request.options) {
    const label = opt.name?.trim() || humanizeKind(opt.kind);
    if (label in optionIdByLabel) continue;
    optionIdByLabel[label] = opt.optionId;
    kindByLabel[label] = opt.kind;
    labels.push(label);
  }
  return {
    event: {
      questionId: randomUUID(),
      prompt,
      options: labels.length > 0 ? labels : undefined,
    },
    optionIdByLabel,
    kindByLabel,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * ACP messages carry an optional `messageId` so chunks belonging to
 * the same agent turn cluster together. When present, we use it as
 * the chunkId so the backend can splice multiple text deltas into
 * one mobile bubble; when absent, we generate a fresh UUID per
 * chunk (each becomes its own bubble — degraded but correct).
 */
function messageChunkId(messageId: string | null | undefined): string {
  if (typeof messageId === 'string' && messageId.length > 0) return messageId;
  return randomUUID();
}

/**
 * Extract a flat string from an ACP {@link ContentBlock}. Today we
 * only handle plain text; image/audio/resource blocks return null
 * (no good way to surface them in the text-first chunk pipeline).
 * Phase 2 can route those to a richer chunk kind.
 */
function extractText(content: ContentBlock): string | null {
  if (!content || typeof content !== 'object') return null;
  if ('type' in content && content.type === 'text') {
    const t = (content as TextContent).text;
    return typeof t === 'string' && t.length > 0 ? t : null;
  }
  return null;
}

/**
 * Render a one-line description of a tool call for the `tool_use`
 * chunk content. Keeps the mobile bubble compact — full tool args
 * are inside the toolCall.content array which we leave to Phase 2.
 */
function describeToolCall(
  call: {
    title?: string | null;
    kind?: string | null;
    rawInput?: unknown;
  },
): string | null {
  const title = call.title?.trim();
  const kind = call.kind?.trim();
  if (title && title.length > 0) return title;
  if (kind && kind.length > 0) return kind;
  if (call.rawInput && typeof call.rawInput === 'object') {
    try {
      const summary = JSON.stringify(call.rawInput);
      // Truncate long stringified inputs so the bubble stays readable.
      if (summary.length > 240) return `${summary.slice(0, 240)}…`;
      return summary;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Render the body of a `tool_result` chunk. ACP's `ToolCallUpdate`
 * carries an optional `content` array of {@link ToolCallContent}
 * (Content blocks, Diff, or Terminal handles). We extract text
 * from each variant and concatenate; fall back to the tool's
 * `title` when nothing renders.
 *
 * Diff / Terminal variants get a one-line summary instead of the
 * raw payload — full diff rendering is a Phase 2 concern (mobile
 * needs a dedicated chunk kind to show side-by-side hunks).
 */
function describeToolCallUpdate(
  update: {
    title?: string | null;
    content?: Array<ToolCallContent> | null;
  },
): string | null {
  const parts: string[] = [];
  if (Array.isArray(update.content)) {
    for (const item of update.content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'content' && item.content) {
        const text = extractText(item.content);
        if (text) parts.push(text);
      } else if (item.type === 'diff') {
        const p = (item as { path?: string }).path;
        parts.push(p ? `diff: ${p}` : 'diff');
      } else if (item.type === 'terminal') {
        const id = (item as { terminalId?: string }).terminalId;
        parts.push(id ? `terminal: ${id}` : 'terminal');
      }
    }
  }
  if (parts.length > 0) return parts.join('\n');
  const title = update.title?.trim();
  return title && title.length > 0 ? title : null;
}

/**
 * Fallback label for permission options that don't ship with a
 * pre-rendered `name`. Maps the kind enum to user-friendly text so
 * mobile never shows a raw `allow_once` string.
 */
function humanizeKind(kind: string): string {
  switch (kind) {
    case 'allow_once':
      return 'Allow once';
    case 'allow_always':
      return 'Always allow';
    case 'reject_once':
      return 'Reject';
    case 'reject_always':
      return 'Always reject';
    default:
      return kind;
  }
}
