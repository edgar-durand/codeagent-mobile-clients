/**
 * codeagent-x3ly — an interactive plan-mode turn must survive the JSONL
 * backfill. Claude often writes the plan ONLY inside the `ExitPlanMode`
 * tool_use input (no text block), and the user's approval is a `tool_result`
 * — the parser kept only `text` blocks, so both vanished from the chat on
 * re-entry while the agent kept working.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseHistoryFile, PLAN_APPROVED_TEXT } from '../../src/agents/claude/history';

const PLAN = '## Plan\n1. Add the migration\n2. Wire the endpoint\n3. Test it';

function parse(records: unknown[]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-plan-'));
  const filePath = path.join(dir, 's.jsonl');
  writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join('\n'));
  try {
    return parseHistoryFile(filePath).map((m) => ({ role: m.role, text: m.text }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const userPrompt = {
  type: 'user',
  uuid: 'u1',
  timestamp: '2026-07-29T10:00:00.000Z',
  message: { role: 'user', content: 'Plan the endpoint' },
};
const planTurn = (extra: unknown[] = []) => ({
  type: 'assistant',
  uuid: 'a1',
  timestamp: '2026-07-29T10:00:05.000Z',
  message: {
    role: 'assistant',
    content: [...extra, { type: 'tool_use', id: 'toolu_plan', name: 'ExitPlanMode', input: { plan: PLAN } }],
  },
});
const answer = (isError: boolean) => ({
  type: 'user',
  uuid: 'u2',
  timestamp: '2026-07-29T10:00:30.000Z',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_plan',
        content: isError ? "The user doesn't want to proceed" : 'User has approved your plan.',
        ...(isError ? { is_error: true } : {}),
      },
    ],
  },
});

describe('claude/history parseHistoryFile — ExitPlanMode turns (codeagent-x3ly)', () => {
  it('renders a tool_use-only plan turn as an agent message and the approval as a user message', () => {
    expect(parse([userPrompt, planTurn(), answer(false)])).toEqual([
      { role: 'user', text: 'Plan the endpoint' },
      { role: 'agent', text: PLAN },
      { role: 'user', text: PLAN_APPROVED_TEXT },
    ]);
  });

  it('keeps the turn text and appends the plan after it', () => {
    const msgs = parse([planTurn([{ type: 'text', text: 'Here is my plan.' }])]);
    expect(msgs).toEqual([{ role: 'agent', text: `Here is my plan.\n\n${PLAN}` }]);
  });

  it('a rejected plan (is_error tool_result) renders no approval bubble', () => {
    expect(parse([userPrompt, planTurn(), answer(true)])).toEqual([
      { role: 'user', text: 'Plan the endpoint' },
      { role: 'agent', text: PLAN },
    ]);
  });

  it('tool_results for OTHER tools stay hidden (no regression)', () => {
    const bash = {
      type: 'assistant',
      uuid: 'a2',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'ls' } }] },
    };
    const bashResult = {
      type: 'user',
      uuid: 'u3',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'a b c' }] },
    };
    expect(parse([bash, bashResult])).toEqual([]);
  });
});
