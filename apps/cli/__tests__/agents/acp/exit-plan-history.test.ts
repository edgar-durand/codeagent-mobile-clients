/**
 * codeagent-x3ly — an interactive ExitPlanMode approval is a conversation
 * turn: the plan and the user's answer must land in the durable AcpHistory
 * (what the turn-close flush pushes), not only on the live awaiting-answer
 * sheet. Before the fix, selectOptionH's `resolved` branch only acked, so the
 * plan + approval vanished from the chat on re-entry.
 *
 * Driven through the REAL permission gate → StreamingState → select_option.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { DEFAULT_GUARDRAIL_POLICY } from '@codeam/shared';
import { AcpPublisher } from '../../../src/agents/acp/publisher';
import { StreamingState } from '../../../src/agents/acp/runner';
import { createOnRequestPermission, exitPlanModePlan } from '../../../src/agents/acp/permission-gate';
import {
  ACP_COMMAND_HANDLERS,
  type AcpCommandContext,
} from '../../../src/agents/acp/command-handlers';

vi.mock('../../../src/services/pairing.service', () => ({
  postTurnEvent: vi.fn().mockResolvedValue(undefined),
  fetchCurrentPluginAuthToken: vi.fn(),
  _postJsonAuthed: vi.fn(),
}));

const PLAN = '## Plan\n1. Add the migration\n2. Wire the endpoint';

const EXIT_PLAN_OPTIONS: PermissionOption[] = [
  { kind: 'allow_always', name: 'Yes, and use "auto" mode', optionId: 'auto' },
  { kind: 'allow_once', name: 'Yes, and manually approve edits', optionId: 'default' },
  { kind: 'reject_once', name: 'No, keep planning', optionId: 'plan' },
];

function request(toolCall: RequestPermissionRequest['toolCall'], options = EXIT_PLAN_OPTIONS): RequestPermissionRequest {
  return { sessionId: 's1', toolCall, options };
}

function makeHarness() {
  const publisher = new AcpPublisher({
    sessionId: 'sess-plan',
    pluginId: 'plugin-plan',
    pluginAuthToken: 'tok',
    apiBaseUrl: 'https://api.example.test',
  });
  vi.spyOn(publisher, 'publishOutput').mockResolvedValue(undefined);
  vi.spyOn(publisher, 'publishStreamingChunk').mockResolvedValue(undefined);
  vi.spyOn(publisher, 'publishAwaitingAnswer').mockResolvedValue(undefined);
  const streaming = new StreamingState(publisher);
  const gate = createOnRequestPermission({
    autoApprovePermissions: false,
    isLocal: () => true,
    getPolicy: () => DEFAULT_GUARDRAIL_POLICY,
    publisher,
    registerPermission: (args) => streaming.registerPermission(args),
  });
  const history = { appendUserPrompt: vi.fn(), appendAgentReply: vi.fn(), flush: vi.fn() };
  const select = async (payload: Record<string, unknown>) => {
    const ctx = {
      cmd: { id: 'cmd-sel', type: 'select_option', payload },
      client: { prompt: vi.fn() },
      relay: { sendResult: vi.fn().mockResolvedValue(undefined) },
      streaming,
      history,
      opts: { agent: 'claude' },
    } as unknown as AcpCommandContext;
    await ACP_COMMAND_HANDLERS.select_option(ctx);
  };
  return { gate, select, history };
}

describe('ExitPlanMode approval is recorded in the durable history (codeagent-x3ly)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records the plan as an agent reply and the picked option as the user answer, in order', async () => {
    const h = makeHarness();
    const answer = h.gate(
      request({ toolCallId: 'toolu_01', title: 'Ready to code?', kind: 'switch_mode', rawInput: { plan: PLAN } }),
    );
    // Let the gate publish the awaiting-answer and register the question.
    await new Promise((r) => setTimeout(r, 0));
    expect(h.history.appendAgentReply).not.toHaveBeenCalled();
    await h.select({ index: 1 });
    expect(await answer).toEqual({ outcome: { outcome: 'selected', optionId: 'default' } });
    expect(h.history.appendAgentReply).toHaveBeenCalledWith(PLAN);
    expect(h.history.appendUserPrompt).toHaveBeenCalledWith('Yes, and manually approve edits');
    expect(h.history.appendAgentReply.mock.invocationCallOrder[0]).toBeLessThan(
      h.history.appendUserPrompt.mock.invocationCallOrder[0],
    );
  });

  it('an ordinary tool permission (Bash) stays out of the conversation history', async () => {
    const h = makeHarness();
    const answer = h.gate(
      request(
        { toolCallId: 'toolu_02', title: 'Bash', kind: 'execute', rawInput: { command: 'ls' } },
        [
          { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
          { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
        ],
      ),
    );
    await new Promise((r) => setTimeout(r, 0));
    await h.select({ index: 0 });
    await answer;
    expect(h.history.appendAgentReply).not.toHaveBeenCalled();
    expect(h.history.appendUserPrompt).not.toHaveBeenCalled();
  });

  it('exitPlanModePlan reads rawInput.plan only', () => {
    expect(exitPlanModePlan({ toolCallId: 'a', rawInput: { plan: PLAN } })).toBe(PLAN);
    expect(exitPlanModePlan({ toolCallId: 'a', rawInput: { plan: '   ' } })).toBeUndefined();
    expect(exitPlanModePlan({ toolCallId: 'a', rawInput: { command: 'ls' } })).toBeUndefined();
    expect(exitPlanModePlan({ toolCallId: 'a' })).toBeUndefined();
  });
});
