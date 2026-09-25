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

/**
 * `bd prime` shell invocations, as the agent's tool call carries them
 * (`rawInput.command` for Bash-style tools, or the call title).
 */
const BD_PRIME_COMMAND_RE = /(?:^|[;&|]\s*)bd\s+prime\b/;

/**
 * Per-session memory of which tool calls were `bd prime` (codeagent-zwp2).
 *
 * WHY: the static beads hint tells every agent to "run `bd prime`", so an
 * agent without a bd SessionStart hook (opencode has no `bd setup` recipe)
 * runs it as a Bash tool call on its FIRST turn. Its result is bd's ~3000-line
 * workflow guide, whose LAST content line is a documentation example:
 * `bd dep add beads-yyy beads-xxx  # Tests depend on Feature …`. That result
 * is published as a `tool_result` streaming chunk, and mobile's activity line
 * renders the latest chunk's last non-empty line — so a newcomer's "Hello"
 * was answered with a bare `bd dep add …` under the reply (replay
 * 01a0ce5c…, 2026-09-23). Not the assistant's text (the chat pipe is
 * `kind:'text'` only), not a narration: our own onboarding scaffolding
 * leaking through a tool result.
 *
 * `bd prime` output is context for the MODEL, never for the person, so its
 * tool_result is collapsed to a one-line summary. Every other tool result is
 * untouched. `tool_call` ids are remembered until their terminal
 * `tool_call_update`, so the map stays bounded.
 */
export class ToolCallTracker {
  private readonly bdPrimeIds = new Set<string>();
  /** Latest non-empty title per open call — see {@link lastTitle}. */
  private readonly titles = new Map<string, string>();

  /** Record a `tool_call` so its later `tool_call_update` can be recognised. */
  note(update: { sessionUpdate: string; toolCallId?: string; title?: string | null; rawInput?: unknown }): void {
    if (!update.toolCallId) return;
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
    const title = update.title?.trim();
    if (title) this.titles.set(update.toolCallId, title);
    if (update.sessionUpdate !== 'tool_call') return;
    if (isBdPrimeInvocation(update)) this.bdPrimeIds.add(update.toolCallId);
  }

  /**
   * The call's most recent title, forgotten once read. claude-agent-acp opens
   * a Write as "Preparing file…", renames it in a non-terminal update
   * ("Write FOO.md"), then completes it with NO content and an EMPTY title —
   * the completion mapped to nothing and the phone showed "Preparing file…"
   * pending forever (break-it 2026-09-24, fleet box).
   */
  lastTitle(toolCallId: string | undefined): string | null {
    if (!toolCallId) return null;
    const title = this.titles.get(toolCallId) ?? null;
    this.titles.delete(toolCallId);
    return title;
  }

  /** True when this tool call was `bd prime`; forgets terminal ids. */
  isBdPrime(toolCallId: string | undefined, terminal: boolean): boolean {
    if (!toolCallId) return false;
    const hit = this.bdPrimeIds.has(toolCallId);
    if (hit && terminal) this.bdPrimeIds.delete(toolCallId);
    return hit;
  }
}

export function isBdPrimeInvocation(call: { title?: string | null; rawInput?: unknown }): boolean {
  const input = call.rawInput as Record<string, unknown> | null | undefined;
  const command = input && typeof input === 'object' ? input.command : undefined;
  if (typeof command === 'string' && BD_PRIME_COMMAND_RE.test(command)) return true;
  return typeof call.title === 'string' && BD_PRIME_COMMAND_RE.test(call.title);
}

/** The tool_result body published in place of `bd prime`'s workflow guide. */
export function bdPrimeResultSummary(body: string): string {
  const lines = body.split('\n').filter((l) => l.trim().length > 0).length;
  return `bd prime · workflow context loaded (${lines} lines)`;
}

export function mapSessionUpdate(
  notification: SessionNotification,
  tracker?: ToolCallTracker,
): ChunkDelta[] {
  const update = notification.update;
  tracker?.note(update as { sessionUpdate: string; toolCallId?: string; title?: string | null; rawInput?: unknown });
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
      const remembered = tracker?.lastTitle(update.toolCallId) ?? null;
      // A terminal update with no body still has to close the row on the
      // phone — fall back to the call's last title.
      const rawBody = describeToolCallUpdate(update) ?? remembered;
      if (!rawBody) return [];
      // `bd prime` output is model context, not user output — collapse it
      // (see ToolCallTracker). A FAILED prime keeps its real body: that is
      // an error the person may need to see.
      const body =
        update.status === 'completed' && tracker?.isBdPrime(update.toolCallId, true)
          ? bdPrimeResultSummary(rawBody)
          : rawBody;
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

/** One ACP permission option as the runner tracks it: the label the
 *  phone renders, the ACP `optionId` the answer must carry back, and
 *  the kind (for logging the user's choice category). */
export interface PermissionOption {
  label: string;
  optionId: string;
  kind: string;
}

/**
 * Map an ACP `session/request_permission` request to our
 * `awaiting-answer` wire shape. Returns the AwaitingAnswerEvent the
 * publisher posts upstream, plus the ordered option list the runner
 * uses to resolve the user's reply back to an ACP `optionId`.
 *
 * Every option goes on the wire as `{ label, value: optionId }`, in the
 * SAME order as the ACP `options[]` array — nothing is dropped or
 * deduplicated, so a client that still answers by position lands on
 * the option it rendered, and a client that echoes `value` back
 * (`select_option.optionId` / `answer`) is resolved by id regardless
 * of position.
 */
export function mapPermissionRequest(
  request: RequestPermissionRequest,
): {
  event: AwaitingAnswerEvent;
  /** Ordered like the ACP `options[]` array — the wire index is this index. */
  options: PermissionOption[];
} {
  const prompt =
    describePermissionToolCall(request.toolCall) ??
    'The agent requested permission to continue.';
  const options: PermissionOption[] = request.options.map((opt) => ({
    label: opt.name?.trim() || humanizeKind(opt.kind),
    optionId: opt.optionId,
    kind: opt.kind,
  }));
  return {
    event: {
      questionId: randomUUID(),
      prompt,
      options:
        options.length > 0
          ? options.map((o) => ({ label: o.label, value: o.optionId }))
          : undefined,
    },
    options,
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

/** Longest tool-input detail (command / path) appended to a permission prompt. */
const PERMISSION_DETAIL_MAX = 400;

/**
 * Pull the one input field a person needs to judge a permission
 * request: the shell command for Bash/Terminal-style calls, else the
 * file path for file tools. Returns null when the input has neither.
 */
function permissionInputDetail(rawInput: unknown): string | null {
  if (!rawInput || typeof rawInput !== 'object') return null;
  const input = rawInput as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim().length > 0) {
      const detail = v.trim();
      return detail.length > PERMISSION_DETAIL_MAX
        ? `${detail.slice(0, PERMISSION_DETAIL_MAX)}…`
        : detail;
    }
  }
  return null;
}

/**
 * Prompt text for a permission card: the tool title, plus the command
 * or path from `rawInput` on its own line whenever the title doesn't
 * already show it. claude-agent-acp titles a Bash prompt with the
 * model's optional `description` and falls back to the bare tool name
 * ("Bash") — so without this the phone asked the user to approve
 * "Bash" with no way to see WHAT would run (replay 01a08b05,
 * 2026-09-10). The input is what the user is actually approving.
 */
function describePermissionToolCall(
  call: RequestPermissionRequest['toolCall'],
): string | null {
  const title = describeToolCall(call);
  const detail = permissionInputDetail(call.rawInput);
  if (!detail) return title;
  if (!title) return detail;
  if (title.includes(detail)) return title;
  return `${title}\n${detail}`;
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
