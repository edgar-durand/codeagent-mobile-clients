/**
 * P2-4 — hydration attribution (codeagent-egai).
 *
 * The conversation push payload's messages carry the agent that PRODUCED each
 * turn. The top-level `agentId` only keys the backend's per-agent bucket, so
 * without this a multi-agent session's RELOADED history collapsed to whichever
 * agent the screen was showing.
 *
 * Two producers are covered: the ACP runner's in-memory `AcpHistory` (live
 * turns) and `HistoryService` (the on-disk JSONL the app hydrates from).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AcpHistory } from '../../../src/agents/acp/runner';
import { HistoryService } from '../../../src/services/history.service';
import type { AcpPublisher } from '../../../src/agents/acp/publisher';
import type { RuntimeStrategy } from '../../../src/agents/strategy';

interface PushedMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  timestamp: number;
  agentId?: string;
}

describe('AcpHistory — per-turn agentId', () => {
  it('stamps the producing agent on both roles', async () => {
    const pushConversation = vi.fn(
      async (_args: { agentId: string; messages: PushedMessage[] }) => undefined,
    );
    const publisher = {
      pushConversation,
      pushSessionList: vi.fn(async () => undefined),
    } as unknown as AcpPublisher;
    const history = new AcpHistory(publisher, { agent: 'codex', acpSessionId: 'conv-1' });
    history.appendUserPrompt('fix the tests');
    history.appendAgentReply('Fixed.');
    await history.flush();

    const args = pushConversation.mock.calls[0][0];
    expect(args.agentId).toBe('codex');
    expect(args.messages.map((m) => [m.role, m.agentId])).toEqual([
      ['user', 'codex'],
      ['agent', 'codex'],
    ]);
  });
});

describe('HistoryService — per-turn agentId on hydrated history', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-hist-attr-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stamps the bucket's own agent on every parsed message", () => {
    fs.writeFileSync(
      path.join(tmpDir, 'conv-1.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-08-14T10:00:00.000Z',
          message: { content: [{ type: 'text', text: 'hello' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-08-14T10:00:01.000Z',
          message: { content: [{ type: 'text', text: 'hi' }] },
        }),
      ].join('\n') + '\n',
    );
    const runtime = {
      id: 'gemini',
      resolveHistoryDir: () => tmpDir,
    } as unknown as RuntimeStrategy;
    const svc = new HistoryService(runtime, 'plugin-1', '/workspaces/proj');
    const messages = (
      svc as unknown as { readConversation(sid: string): PushedMessage[] }
    ).readConversation('conv-1');
    expect(messages.map((m) => m.agentId)).toEqual(['gemini', 'gemini']);
  });
});
