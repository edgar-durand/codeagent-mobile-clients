/**
 * codeagent-37o1 — a trailing ```codeam-handoff fence must never be PERSISTED
 * on the secondary reply paths.
 *
 * `StreamingState.getCurrentText()` deliberately returns the RAW buffer (fence
 * included) so `start_task` can parse the proposal out of it; only the live
 * frames are fence-stripped. `start_task` persists `extractHandoffProposal`'s
 * cleanText, but group_mention_task / select_option (reprompt) / provide_input
 * / summarize passed the raw buffer straight to `history.appendAgentReply`, so
 * the fence landed in the durable conversation and resurfaced on reload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HANDOFF_FENCE_TAG } from '@codeam/shared';
import { AcpPublisher } from '../../../src/agents/acp/publisher';
import { StreamingState } from '../../../src/agents/acp/runner';
import {
  ACP_COMMAND_HANDLERS,
  type AcpCommandContext,
} from '../../../src/agents/acp/command-handlers';
import * as pairing from '../../../src/services/pairing.service';

vi.mock('../../../src/services/pairing.service', () => ({
  postTurnEvent: vi.fn().mockResolvedValue(undefined),
  fetchCurrentPluginAuthToken: vi.fn(),
  _postJsonAuthed: vi.fn().mockResolvedValue({}),
}));

const PROSE = 'Done — the migration is in place.';
const FENCE =
  '\n\n```' +
  HANDOFF_FENCE_TAG +
  '\n{"to":"codex","reason":"review","prompt":"please review the diff"}\n```';

function makeHarness() {
  const publisher = new AcpPublisher({
    sessionId: 'sess-fence',
    pluginId: 'plugin-fence',
    pluginAuthToken: 'tok-fence',
    apiBaseUrl: 'https://api.example.test',
  });
  vi.spyOn(publisher, 'publishOutput').mockResolvedValue(undefined);
  vi.spyOn(publisher, 'publishStreamingChunk').mockResolvedValue(undefined);
  const streaming = new StreamingState(publisher);
  const appendAgentReply = vi.fn();
  // The agent's reply streams in through `append`, exactly like the ACP
  // session/update notifications do, and ENDS with a handoff fence.
  const prompt = vi.fn(async () => {
    streaming.append({ chunkId: 'msg-1', kind: 'text', delta: PROSE });
    streaming.append({ chunkId: 'msg-1', kind: 'text', delta: FENCE });
    return { stopReason: 'end_turn' };
  });
  const run = async (type: string, payload: Record<string, unknown>) => {
    const ctx = {
      cmd: { id: 'cmd-1', type, payload },
      client: { prompt, cancel: vi.fn() },
      relay: { sendResult: vi.fn().mockResolvedValue(undefined) },
      streaming,
      history: { appendUserPrompt: vi.fn(), appendAgentReply, flush: vi.fn() },
      turnFiles: { flushTurn: vi.fn().mockResolvedValue(undefined) },
      opts: { agent: 'claude', sessionId: 'sess-fence', pluginId: 'plugin-fence', pluginAuthToken: 'tok' },
    } as unknown as AcpCommandContext;
    await ACP_COMMAND_HANDLERS[type](ctx);
  };
  return { streaming, appendAgentReply, run };
}

function expectCleanReply(appendAgentReply: ReturnType<typeof vi.fn>): void {
  expect(appendAgentReply).toHaveBeenCalledTimes(1);
  const persisted = appendAgentReply.mock.calls[0][0] as string;
  expect(persisted).toContain(PROSE);
  expect(persisted).not.toContain(HANDOFF_FENCE_TAG);
  expect(persisted).not.toContain('please review the diff');
}

describe('secondary reply paths persist the fence-stripped reply (codeagent-37o1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('provide_input', async () => {
    const h = makeHarness();
    await h.run('provide_input', { input: 'yes, go ahead' });
    expectCleanReply(h.appendAgentReply);
  });

  it('summarize', async () => {
    const h = makeHarness();
    await h.run('summarize', {});
    expectCleanReply(h.appendAgentReply);
  });

  it('select_option (free-form reprompt)', async () => {
    const h = makeHarness();
    h.streaming.registerFreeformOptions(['Option A', 'Option B']);
    await h.run('select_option', { index: 1 });
    expectCleanReply(h.appendAgentReply);
  });

  it('group_mention_task — both the durable reply and the group round-trip', async () => {
    const h = makeHarness();
    await h.run('group_mention_task', { taskId: 'task-1', prompt: 'summarize the PR' });
    expectCleanReply(h.appendAgentReply);
    const body = vi.mocked(pairing._postJsonAuthed).mock.calls[0][1] as { response: string };
    expect(body.response).toContain(PROSE);
    expect(body.response).not.toContain(HANDOFF_FENCE_TAG);
  });
});
