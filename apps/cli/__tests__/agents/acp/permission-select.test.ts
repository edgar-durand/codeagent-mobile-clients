/**
 * permission-select.test.ts
 *
 * The `select_option` → ACP permission answer path, end to end through the
 * real `StreamingState` + `selectOptionH` handler.
 *
 * Replay 01a08b05 (2026-09-10, iOS b106): the user tapped "Yes, and don't
 * ask again for similar commands" — the SECOND of [Yes, Yes-and-don't-ask,
 * No] — and Claude replied "User refused permission to run tool". The
 * box's `~/.codeam/debug-958.log` shows why:
 *
 *     11:37:31.826Z relay — sse received 1 command(s) types=[select_option]
 *     11:37:31.827Z acpRunner — select_option index=2 → permission resolved
 *     11:37:31.833Z … tool_result:"[failed] ```\nUser refused permission to run tool\n```"
 *
 * Mobile (and web) send `{ index, from }` where `from` is the PTY
 * keyboard CURSOR ("navigate from row X to row Y") and equals `index`
 * when there is no cursor. The ACP handler added it as an OFFSET
 * (`index + from`), so index 1 became 2 = `reject`, and "No" (2 → 4)
 * fell out of bounds and was reported as a cancel. Only "Yes" (0) ever
 * worked.
 *
 * Invariants pinned here:
 *  1. `from` is ignored — index 1 with from 1 resolves ACP options[1].
 *  2. An `optionId` (or the echoed `answer` value) wins over the index.
 *  3. An optionId that matches nothing falls back to the index.
 *  4. The TTL expiry answers `cancelled` AND publishes a visible chat
 *     line saying the request EXPIRED — not that the user refused.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { AcpPublisher } from '../../../src/agents/acp/publisher';
import { StreamingState, PERMISSION_TIMEOUT_MS } from '../../../src/agents/acp/runner';
import {
  ACP_COMMAND_HANDLERS,
  type AcpCommandContext,
} from '../../../src/agents/acp/command-handlers';

vi.mock('../../../src/services/pairing.service', () => ({
  fetchCurrentPluginAuthToken: vi.fn(),
  _postJsonAuthed: vi.fn(),
}));

/** [Yes, Yes-and-don't-ask-again, No] — what claude-agent-acp sends for Bash. */
const BASH_OPTIONS = [
  { label: 'Yes', optionId: 'allow-once', kind: 'allow_once' },
  {
    label: "Yes, and don't ask again for similar commands",
    optionId: 'allow-with-updates',
    kind: 'allow_always',
  },
  { label: 'No', optionId: 'reject', kind: 'reject_once' },
];

function makeHarness() {
  const publisher = new AcpPublisher({
    sessionId: 'sess-perm',
    pluginId: 'plugin-perm',
    pluginAuthToken: 'tok-perm',
    apiBaseUrl: 'https://api.example.test',
  });
  const publishOutput = vi.spyOn(publisher, 'publishOutput').mockResolvedValue(undefined);
  vi.spyOn(publisher, 'publishStreamingChunk').mockResolvedValue(undefined);
  const streaming = new StreamingState(publisher);
  const sendResult = vi.fn().mockResolvedValue(undefined);
  const ctxBase = {
    client: { prompt: vi.fn() },
    relay: { sendResult },
    streaming,
    history: { appendUserPrompt: vi.fn(), appendAgentReply: vi.fn(), flush: vi.fn() },
    budgetRecovery: { tryRecover: vi.fn().mockResolvedValue(false) },
    opts: { agent: 'claude' },
  };
  const select = async (payload: Record<string, unknown>) => {
    const ctx = {
      ...ctxBase,
      cmd: { id: 'cmd-1', type: 'select_option', payload },
    } as unknown as AcpCommandContext;
    await ACP_COMMAND_HANDLERS.select_option(ctx);
  };
  const register = () => streaming.registerPermission({ questionId: 'q-1', options: BASH_OPTIONS });
  return { streaming, publishOutput, sendResult, select, register };
}

async function settled(p: Promise<RequestPermissionResponse>): Promise<RequestPermissionResponse> {
  return await p;
}

describe('select_option → ACP permission answer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ignores `from` (the PTY cursor): index 1 + from 1 is options[1], not options[2]', async () => {
    const h = makeHarness();
    const answer = h.register();
    await h.select({ index: 1, from: 1 });
    expect(await settled(answer)).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-with-updates' },
    });
    expect(h.sendResult).toHaveBeenCalledWith('cmd-1', 'completed', {});
  });

  it('"No" (index 2, from 2) is the reject option, not an out-of-bounds cancel', async () => {
    const h = makeHarness();
    const answer = h.register();
    await h.select({ index: 2, from: 2 });
    expect(await settled(answer)).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });
  });

  it('resolves by optionId when the payload carries one, regardless of the index', async () => {
    const h = makeHarness();
    const answer = h.register();
    // A stale/wrong index must not matter once the id is on the wire.
    await h.select({ index: 0, from: 0, optionId: 'allow-with-updates' });
    expect(await settled(answer)).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-with-updates' },
    });
  });

  it('accepts the echoed `answer` value as the optionId (what mobile already sends)', async () => {
    const h = makeHarness();
    const answer = h.register();
    await h.select({ index: 1, from: 1, questionId: 'q-1', answer: 'reject' });
    expect(await settled(answer)).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });
  });

  it('falls back to the index when the optionId / answer matches no option (legacy "1")', async () => {
    const h = makeHarness();
    const answer = h.register();
    await h.select({ index: 1, from: 1, answer: '1' });
    expect(await settled(answer)).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-with-updates' },
    });
  });

  it('an index past the end still cancels (never a silent reject)', async () => {
    const h = makeHarness();
    const answer = h.register();
    await h.select({ index: 7 });
    expect(await settled(answer)).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('TTL expiry cancels AND tells the user the request expired — not that they refused', async () => {
    const h = makeHarness();
    const answer = h.register();
    await vi.advanceTimersByTimeAsync(PERMISSION_TIMEOUT_MS + 1);
    expect(await settled(answer)).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(h.publishOutput).toHaveBeenCalledTimes(1);
    const body = h.publishOutput.mock.calls[0][0] as {
      type: string;
      content: string;
      done: boolean;
    };
    expect(body.type).toBe('text');
    expect(body.done).toBe(true);
    expect(body.content).toMatch(/expired/i);
    expect(body.content).toMatch(/not a refusal by you/i);
    expect(body.content).not.toMatch(/refused/i);
    // Answering after expiry is a stale answer, not a second resolution.
    await h.select({ index: 1, from: 1 });
    expect(h.sendResult).toHaveBeenLastCalledWith(
      'cmd-1',
      'failed',
      expect.objectContaining({ error: expect.stringMatching(/expired/i) }),
    );
  });

  it('a user answer before the TTL publishes no expiry line', async () => {
    const h = makeHarness();
    const answer = h.register();
    await h.select({ index: 0 });
    await settled(answer);
    await vi.advanceTimersByTimeAsync(PERMISSION_TIMEOUT_MS + 1);
    expect(h.publishOutput).not.toHaveBeenCalled();
  });
});
