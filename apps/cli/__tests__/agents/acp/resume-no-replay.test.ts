import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpClient } from '../../../src/agents/acp/client';
import { autoResumeLatestConversation } from '../../../src/agents/acp/runner';

/**
 * codeagent-2238: on a box wake (CODEAM_RESUME_LATEST) the runner reopened the
 * prior conversation with `session/load`, which replays the WHOLE conversation
 * before it answers — 14 s on the QA Box — and only then started the relay, so
 * a prompt queued during the wake sat behind a replay the runner throws away.
 * Agents advertising `sessionCapabilities.resume` now reopen with
 * `session/resume` (same session, no replay).
 */

const posix = process.platform !== 'win32';

// A real ACP agent over stdio (the SDK's AgentSideConnection). `load` replays
// REPLAY_COUNT updates before answering, like claude-agent-acp; `resume` does
// not. Every RPC it serves is appended to FAKE_CALLS_FILE.
const FAKE_AGENT = String.raw`
  const { AgentSideConnection, ndJsonStream } = require('@agentclientprotocol/sdk');
  const { Writable, Readable } = require('node:stream');
  const { writeFileSync } = require('node:fs');
  const callsFile = process.env.FAKE_CALLS_FILE;
  const withResume = process.env.FAKE_WITH_RESUME === '1';
  const calls = [];
  const log = (m) => { calls.push(m); writeFileSync(callsFile, JSON.stringify(calls)); };
  let conn;
  const agent = {
    async initialize() {
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: withResume ? { resume: {} } : {},
        },
      };
    },
    async newSession() { log('new'); return { sessionId: 'fresh-1' }; },
    async loadSession(p) {
      log('load:' + p.sessionId);
      for (let i = 0; i < 20; i++) {
        await conn.sessionUpdate({
          sessionId: p.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old ' + i } },
        });
      }
      return {};
    },
    async resumeSession(p) { log('resume:' + p.sessionId); return {}; },
    async closeSession(p) { log('close:' + p.sessionId); return {}; },
    async prompt() { return { stopReason: 'end_turn' }; },
    async cancel() {},
  };
  conn = new AgentSideConnection(() => agent, ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
  setInterval(() => {}, 1000);
`;

function calls(file: string): string[] {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as string[]) : [];
}

function makeClient(callsFile: string, withResume: boolean, onUpdate: () => void): AcpClient {
  return new AcpClient({
    adapter: { command: process.execPath, args: ['-e', FAKE_AGENT] },
    cwd: process.cwd(),
    extraEnv: { FAKE_CALLS_FILE: callsFile, FAKE_WITH_RESUME: withResume ? '1' : '0' },
    onSessionUpdate: onUpdate,
    onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    onExit: () => undefined,
  } as never);
}

describe.runIf(posix)('AcpClient.loadSession({ preferResume }) — reopen without the replay', () => {
  const clients: AcpClient[] = [];
  afterEach(async () => {
    for (const c of clients) await c.stop().catch(() => undefined);
    clients.length = 0;
  });

  it('uses session/resume when the agent advertises it: no replayed updates', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'acp-resume-')), 'calls.json');
    const onUpdate = vi.fn();
    const client = makeClient(file, true, onUpdate);
    clients.push(client);
    await client.start();

    await client.loadSession('prior-1', { preferResume: true });

    expect(calls(file)).toContain('resume:prior-1');
    expect(calls(file).some((c) => c.startsWith('load:'))).toBe(false);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(client.getActiveSessionId()).toBe('prior-1');
    // Same tail as a load: the fresh session it walked away from is closed.
    expect(calls(file)).toContain('close:fresh-1');
  }, 30_000);

  it('falls back to session/load for an agent without session/resume', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'acp-resume-')), 'calls.json');
    const client = makeClient(file, false, () => undefined);
    clients.push(client);
    await client.start();

    await client.loadSession('prior-2', { preferResume: true });

    expect(calls(file)).toContain('load:prior-2');
    expect(client.getActiveSessionId()).toBe('prior-2');
  }, 30_000);

  it('without preferResume it still loads (the RECENT-sheet resume is unchanged)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'acp-resume-')), 'calls.json');
    const client = makeClient(file, true, () => undefined);
    clients.push(client);
    await client.start();

    await client.loadSession('prior-3');

    expect(calls(file)).toContain('load:prior-3');
    expect(calls(file).some((c) => c.startsWith('resume:'))).toBe(false);
  }, 30_000);
});

describe('autoResumeLatestConversation (box-wake auto-resume)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-autoresume-cwd-')); // no marker for this cwd

  it('reopens the latest prior conversation with preferResume', async () => {
    const client = {
      listSessions: vi.fn(async () => [
        { id: 'older', summary: '', timestamp: 1 },
        { id: 'latest', summary: '', timestamp: 2 },
        { id: 'fresh', summary: '', timestamp: 3 },
      ]),
      loadSession: vi.fn(async () => {}),
    };
    const out = await autoResumeLatestConversation(client, cwd, 'fresh');
    expect(client.loadSession).toHaveBeenCalledWith('latest', { preferResume: true });
    expect(out).toEqual({ acpSessionId: 'latest', resumedPriorConversation: true, marked: null });
  });

  it('keeps the fresh session when the reopen fails', async () => {
    const client = {
      listSessions: vi.fn(async () => [{ id: 'latest', summary: '', timestamp: 2 }]),
      loadSession: vi.fn(async () => {
        throw new Error('ACP_LOAD_SESSION_TIMEOUT');
      }),
    };
    const out = await autoResumeLatestConversation(client, cwd, 'fresh');
    expect(out).toEqual({ acpSessionId: 'fresh', resumedPriorConversation: false, marked: null });
  });

  it('keeps the fresh session when there is nothing to resume', async () => {
    const client = { listSessions: vi.fn(async () => null), loadSession: vi.fn(async () => {}) };
    const out = await autoResumeLatestConversation(client, cwd, 'fresh');
    expect(client.loadSession).not.toHaveBeenCalled();
    expect(out.acpSessionId).toBe('fresh');
  });
});
