/**
 * codeagent-zwp2 — a bare `bd dep add <id> <id>` line under the assistant's
 * reply (replay 01a0ce5c…, opencode, 2026-09-23).
 *
 * This fixture drives the mapper with the ACP session/update stream that
 * produced it and pins down BOTH halves of the finding:
 *
 *   1. The publisher/mapper NEVER turns a tool call's command text or a tool
 *      result into a `text` (chat-bubble) delta — candidate mechanism (a) is
 *      ruled out by construction.
 *   2. The line came from `bd prime`'s tool_result (bd's workflow guide ends
 *      with the docs example `bd dep add beads-yyy beads-xxx  # Tests depend
 *      on …`), published as a `tool_result` streaming chunk whose last
 *      non-empty line mobile renders as the activity line. That result is now
 *      collapsed to a one-line summary; every other tool result is untouched.
 */
import { describe, expect, it } from 'vitest';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import {
  ToolCallTracker,
  bdPrimeResultSummary,
  isBdPrimeInvocation,
  mapSessionUpdate,
} from '../../../src/agents/acp/mappers';

function n(update: SessionNotification['update']): SessionNotification {
  return { sessionId: 'sess-1', update };
}

/** Tail of a real `bd prime` (bd 1.2.2) — the line that leaked is the last one. */
const BD_PRIME_OUTPUT = [
  '# Beads Workflow',
  '',
  '- `bd dep add <issue> <depends-on>` - Add dependency (issue depends on depends-on)',
  '',
  '```bash',
  'bd create --title="Implement feature X" --type=feature',
  'bd create --title="Write tests for X" --type=task',
  'bd dep add beads-yyy beads-xxx  # Tests depend on Feature (Feature blocks tests)',
  '```',
].join('\n');

function bashCall(toolCallId: string, command: string): SessionNotification['update'] {
  return {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: command,
    kind: 'execute',
    status: 'pending',
    rawInput: { command },
  } as SessionNotification['update'];
}

function bashResult(
  toolCallId: string,
  output: string,
  status: 'completed' | 'failed' = 'completed',
): SessionNotification['update'] {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status,
    content: [{ type: 'content', content: { type: 'text', text: output } }],
  } as SessionNotification['update'];
}

describe('bd prime tool_result collapse (codeagent-zwp2)', () => {
  it('a tool call / tool result never becomes a text (chat) delta — mechanism (a) ruled out', () => {
    const tracker = new ToolCallTracker();
    const stream = [
      n(bashCall('call_1', 'bd dep add beads-abc beads-def')),
      n(bashResult('call_1', 'Added dependency')),
    ];
    const deltas = stream.flatMap((s) => mapSessionUpdate(s, tracker));
    expect(deltas.map((d) => d.kind)).toEqual(['tool_use', 'tool_result']);
    expect(deltas.some((d) => d.kind === 'text')).toBe(false);
  });

  it('collapses the completed `bd prime` result to a one-line summary (no `bd dep add …` tail)', () => {
    const tracker = new ToolCallTracker();
    mapSessionUpdate(n(bashCall('call_prime', 'bd prime')), tracker);
    const [result] = mapSessionUpdate(n(bashResult('call_prime', BD_PRIME_OUTPUT)), tracker);
    expect(result.kind).toBe('tool_result');
    expect(result.delta).toBe('bd prime · workflow context loaded (7 lines)');
    expect(result.delta).not.toContain('bd dep add');
  });

  it('recognises `bd prime` inside a compound shell line and via the title when rawInput is absent', () => {
    expect(isBdPrimeInvocation({ rawInput: { command: 'cd /repo && bd prime 2>/dev/null' } })).toBe(true);
    expect(isBdPrimeInvocation({ title: 'bd prime', rawInput: undefined })).toBe(true);
    expect(isBdPrimeInvocation({ rawInput: { command: 'bd primer --help' } })).toBe(false);
    expect(isBdPrimeInvocation({ rawInput: { command: 'echo "not bd prime"' } })).toBe(false);
  });

  it('leaves every other tool result untouched, byte for byte', () => {
    const tracker = new ToolCallTracker();
    mapSessionUpdate(n(bashCall('call_ls', 'bd list --json')), tracker);
    const [result] = mapSessionUpdate(n(bashResult('call_ls', BD_PRIME_OUTPUT)), tracker);
    expect(result.delta).toBe(BD_PRIME_OUTPUT);
  });

  it('keeps the real body of a FAILED `bd prime` (an error the person may need)', () => {
    const tracker = new ToolCallTracker();
    mapSessionUpdate(n(bashCall('call_prime', 'bd prime')), tracker);
    const [result] = mapSessionUpdate(
      n(bashResult('call_prime', 'Error: no active beads workspace found', 'failed')),
      tracker,
    );
    expect(result.delta).toBe('[failed] Error: no active beads workspace found');
  });

  it('forgets the id after the terminal update (bounded) and is a no-op without a tracker', () => {
    const tracker = new ToolCallTracker();
    mapSessionUpdate(n(bashCall('call_prime', 'bd prime')), tracker);
    mapSessionUpdate(n(bashResult('call_prime', BD_PRIME_OUTPUT)), tracker);
    expect(tracker.isBdPrime('call_prime', false)).toBe(false);
    // Legacy call shape (no tracker) still maps a result verbatim.
    const [plain] = mapSessionUpdate(n(bashResult('call_prime', BD_PRIME_OUTPUT)));
    expect(plain.delta).toBe(BD_PRIME_OUTPUT);
  });

  it('bdPrimeResultSummary counts non-empty lines', () => {
    expect(bdPrimeResultSummary('a\n\nb\n  \nc')).toBe('bd prime · workflow context loaded (3 lines)');
  });
});
