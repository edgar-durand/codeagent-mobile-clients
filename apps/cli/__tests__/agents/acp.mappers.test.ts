/**
 * Tests for the pure ACP → chunk / awaiting-answer mappers.
 *
 * Drives them with hand-built notification + permission-request
 * fixtures that mirror what {@link AcpClient} forwards from the
 * SDK. No process spawn, no I/O — fast feedback on every variant.
 */

import { describe, expect, it } from 'vitest';
import type {
  RequestPermissionRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { mapPermissionRequest, mapSessionUpdate } from '../../src/agents/acp/mappers';

function notification(update: SessionNotification['update']): SessionNotification {
  return { sessionId: 'sess-1', update };
}

describe('mapSessionUpdate', () => {
  it('maps agent_message_chunk → text chunk keyed by messageId', () => {
    const chunks = mapSessionUpdate(
      notification({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-42',
        content: { type: 'text', text: 'Hello!' },
      }),
    );
    expect(chunks).toEqual([
      { chunkId: 'msg-42', kind: 'text', delta: 'Hello!'  },
    ]);
  });

  it('maps agent_thought_chunk → thinking chunk, namespaced off the messageId', () => {
    const chunks = mapSessionUpdate(
      notification({
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'msg-7',
        content: { type: 'text', text: 'Considering options…' },
      }),
    );
    expect(chunks).toEqual([
      { chunkId: 'msg-7::thought', kind: 'thinking', delta: 'Considering options…' },
    ]);
  });

  it('keeps thought + reply on DISTINCT chunkIds when they share a messageId (no kind flip)', () => {
    // Claude streams a thought and the reply under ONE messageId. They
    // MUST land on different chunkIds, or the mobile store latches one
    // kind and the reply text leaks into the live-activity line.
    const thought = mapSessionUpdate(
      notification({
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'msg-9',
        content: { type: 'text', text: 'thinking…' },
      }),
    );
    const message = mapSessionUpdate(
      notification({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-9',
        content: { type: 'text', text: 'the answer' },
      }),
    );
    expect(thought[0].kind).toBe('thinking');
    expect(message[0].kind).toBe('text');
    expect(thought[0].chunkId).not.toBe(message[0].chunkId);
  });

  it('drops user_message_chunk (local echo)', () => {
    const chunks = mapSessionUpdate(
      notification({
        sessionUpdate: 'user_message_chunk',
        messageId: 'msg-x',
        content: { type: 'text', text: 'hi' },
      }),
    );
    expect(chunks).toEqual([]);
  });

  it('drops non-text content blocks (image / audio not yet supported)', () => {
    const chunks = mapSessionUpdate(
      notification({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-z',
        // @ts-expect-error — drive the path for a future block kind
        content: { type: 'image', source: 'base64', data: 'AAAA' },
      }),
    );
    expect(chunks).toEqual([]);
  });

  it('maps tool_call → tool_use keyed by toolCallId, prefers title', () => {
    const chunks = mapSessionUpdate(
      notification({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'Reading apps/cli/src/agents/acp/runner.ts',
        kind: 'read',
      }),
    );
    expect(chunks).toEqual([
      {
        chunkId: 'call-1',
        kind: 'tool_use',
        delta: 'Reading apps/cli/src/agents/acp/runner.ts',

      },
    ]);
  });

  it('tool_call falls back to kind, then to rawInput', () => {
    const fromKind = mapSessionUpdate(
      notification({
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: '',
        kind: 'execute',
      }),
    );
    expect(fromKind[0]?.delta).toBe('execute');

    const fromRaw = mapSessionUpdate(
      notification({
        sessionUpdate: 'tool_call',
        toolCallId: 'c2',
        title: '',
        rawInput: { command: 'ls' },
      }),
    );
    expect(fromRaw[0]?.delta).toBe('{"command":"ls"}');
  });

  it('tool_call_update drops while pending/in_progress, emits on completed', () => {
    const pending = mapSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'in_progress',
      }),
    );
    expect(pending).toEqual([]);

    const completed = mapSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: '42 results' } }],
      }),
    );
    expect(completed).toEqual([
      { chunkId: 'c1', kind: 'tool_result', delta: '42 results'  },
    ]);
  });

  it('failed tool_call_update prefixes the body with [failed]', () => {
    const failed = mapSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'permission denied' } }],
      }),
    );
    expect(failed[0]?.delta).toBe('[failed] permission denied');
  });

  it('tool_call_update with diff / terminal content summarises instead of dumping', () => {
    const diff = mapSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        // @ts-expect-error — minimal diff shape, the union has more fields we don't need
        content: [{ type: 'diff', path: 'src/foo.ts' }],
      }),
    );
    expect(diff[0]?.delta).toBe('diff: src/foo.ts');
  });

  it('ignores informational variants (plan / usage_update / config_option_update)', () => {
    expect(
      mapSessionUpdate(
        notification({
          sessionUpdate: 'usage_update',
        } as never),
      ),
    ).toEqual([]);
    expect(
      mapSessionUpdate(
        notification({
          sessionUpdate: 'plan',
          entries: [],
        } as never),
      ),
    ).toEqual([]);
  });

  it('forward-compat: unknown session/update variant drops silently', () => {
    const chunks = mapSessionUpdate(
      notification({
        sessionUpdate: 'future_variant',
        anything: true,
      } as never),
    );
    expect(chunks).toEqual([]);
  });
});

describe('mapPermissionRequest', () => {
  // `as const` preserves the kind literal so it satisfies the SDK's
  // ToolKind union (otherwise TS widens to `string`).
  const baseToolCall = {
    toolCallId: 'tc-1',
    title: 'Run `rm -rf /`',
    kind: 'execute',
  } as const;

  it('builds an awaiting-answer event with the tool title as prompt + option labels', () => {
    const req: RequestPermissionRequest = {
      sessionId: 'sess-1',
      toolCall: baseToolCall,
      options: [
        { kind: 'allow_once', name: 'Allow once', optionId: 'opt-allow' },
        { kind: 'reject_once', name: 'Reject', optionId: 'opt-reject' },
      ],
    };
    const { event, optionIdByLabel } = mapPermissionRequest(req);
    expect(event.prompt).toBe('Run `rm -rf /`');
    expect(event.options).toEqual(['Allow once', 'Reject']);
    expect(optionIdByLabel).toEqual({
      'Allow once': 'opt-allow',
      Reject: 'opt-reject',
    });
    expect(event.questionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('humanises bare option kinds when the adapter omits a name', () => {
    const req: RequestPermissionRequest = {
      sessionId: 'sess-1',
      toolCall: baseToolCall,
      options: [
        { kind: 'allow_always', optionId: 'a', name: '' },
        { kind: 'reject_always', optionId: 'r', name: '' },
      ],
    };
    const { event } = mapPermissionRequest(req);
    expect(event.options).toEqual(['Always allow', 'Always reject']);
  });

  it('falls back to a generic prompt when the tool has no title / kind', () => {
    const req: RequestPermissionRequest = {
      sessionId: 'sess-1',
      toolCall: { toolCallId: 'tc-no-title' },
      options: [{ kind: 'allow_once', optionId: 'a', name: 'OK' }],
    };
    const { event } = mapPermissionRequest(req);
    expect(event.prompt).toBe('The agent requested permission to continue.');
  });

  it('deduplicates options that collapse to the same label', () => {
    const req: RequestPermissionRequest = {
      sessionId: 'sess-1',
      toolCall: baseToolCall,
      options: [
        { kind: 'allow_once', name: 'Allow once', optionId: 'first' },
        { kind: 'allow_once', name: 'Allow once', optionId: 'second' },
      ],
    };
    const { event, optionIdByLabel } = mapPermissionRequest(req);
    expect(event.options).toEqual(['Allow once']);
    expect(optionIdByLabel).toEqual({ 'Allow once': 'first' });
  });
});
