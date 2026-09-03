import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpClient } from '../../src/agents/acp/client';

/**
 * A REAL ACP server over real stdio — the SDK's own `AgentSideConnection` — not
 * a mocked client, because a mocked client is exactly what let this ship: the
 * mocks asserted `loadSession` was CALLED, which it was, and never modelled
 * that the agent keeps every session it was ever asked to open.
 *
 * The bug: `start()` always does `session/new`; auto-resume (and the baton)
 * then does `session/load <prior>`. `claude-agent-acp` implements load by
 * launching a SECOND `claude --resume` and — being a multi-session protocol —
 * never closes the first. Two live agents under one adapter, each with its own
 * copy of every MCP server: 28 servers on a 512-pid box, the second wave losing
 * the fork race, and clickup/trello/figma/supabase coming up with NO server
 * (rafaelph90.br@gmail.com, 8e1405644222, 2026-09-03 — a CLEAN start).
 *
 * The fake agent below records every session it holds open. The assertion is
 * that after `start()` + `loadSession(prior)` exactly ONE remains: the loaded
 * one. The control shows the pre-fix world — without `session/close`, two.
 */

const posix = process.platform !== 'win32';

// The fake agent, run as a real child process. It speaks ACP over stdio via the
// SDK and writes the set of OPEN session ids to a file after every change, so
// the test can read what the agent believes is alive.
const FAKE_AGENT = String.raw`
  const { AgentSideConnection, ndJsonStream } = require('@agentclientprotocol/sdk');
  const { Writable, Readable } = require('node:stream');
  const { writeFileSync } = require('node:fs');
  const stateFile = process.env.FAKE_STATE_FILE;
  const open = new Set();
  const dump = () => writeFileSync(stateFile, JSON.stringify([...open]));
  const agent = {
    async initialize() {
      return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
    },
    async newSession() {
      const id = 'fresh-' + Math.random().toString(36).slice(2, 8);
      open.add(id); dump();
      return { sessionId: id };
    },
    async loadSession(p) {
      // Like claude-agent-acp: loading OPENS another live session and does
      // not touch any existing one.
      open.add(p.sessionId); dump();
      return {};
    },
    async closeSession(p) {
      open.delete(p.sessionId); dump();
      return {};
    },
    async prompt() { return { stopReason: 'end_turn' }; },
    async cancel() {},
  };
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin);
  new AgentSideConnection(() => agent, ndJsonStream(input, output));
  dump();
  setInterval(() => {}, 1000);
`;

function openSessions(file: string): string[] {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as string[]) : [];
}

async function waitFor(pred: () => boolean, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return pred();
}

function makeClient(stateFile: string): AcpClient {
  return new AcpClient({
    adapter: { command: process.execPath, args: ['-e', FAKE_AGENT] },
    cwd: process.cwd(),
    extraEnv: { FAKE_STATE_FILE: stateFile },
    onSessionUpdate: () => undefined,
    onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    onExit: () => undefined,
  } as never);
}

describe.runIf(posix)('AcpClient.loadSession closes the fresh session it abandons', () => {
  const clients: AcpClient[] = [];
  afterEach(async () => {
    for (const c of clients) await c.stop().catch(() => undefined);
    clients.length = 0;
  });

  it('leaves exactly ONE open session — the loaded one — after start() + loadSession()', async () => {
    const stateFile = join(mkdtempSync(join(tmpdir(), 'acp-load-')), 'open.json');
    const client = makeClient(stateFile);
    clients.push(client);

    await client.start();
    // start() minted a fresh session; the agent holds one.
    expect(await waitFor(() => openSessions(stateFile).length === 1)).toBe(true);
    const fresh = openSessions(stateFile)[0];
    expect(fresh.startsWith('fresh-')).toBe(true);

    await client.loadSession('prior-conversation');

    // ⚠️ THE assertion. Before the fix this was ['fresh-…', 'prior-conversation']
    // — two live agents, two copies of every MCP server.
    const settled = await waitFor(() => {
      const s = openSessions(stateFile);
      return s.length === 1 && s[0] === 'prior-conversation';
    });
    expect(settled).toBe(true);
    expect(openSessions(stateFile)).toEqual(['prior-conversation']);
  }, 30_000);

  it('control: the agent itself keeps BOTH open unless told to close — the leak is real', async () => {
    // Drive the same fake agent through the SDK without our client, doing what
    // the client did before the fix: new, then load, no close.
    const { ClientSideConnection, ndJsonStream } = await import('@agentclientprotocol/sdk');
    const { spawn } = await import('node:child_process');
    const { Writable, Readable } = await import('node:stream');
    const stateFile = join(mkdtempSync(join(tmpdir(), 'acp-load-ctl-')), 'open.json');
    const child = spawn(process.execPath, ['-e', FAKE_AGENT], {
      env: { ...process.env, FAKE_STATE_FILE: stateFile },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    try {
      const conn = new ClientSideConnection(
        () => ({
          requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
          sessionUpdate: async () => undefined,
        }),
        ndJsonStream(
          Writable.toWeb(child.stdin!) as never,
          Readable.toWeb(child.stdout!) as never,
        ),
      );
      await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
      await conn.newSession({ cwd: process.cwd(), mcpServers: [] });
      await conn.loadSession({ sessionId: 'prior-conversation', cwd: process.cwd(), mcpServers: [] });
      expect(await waitFor(() => openSessions(stateFile).length === 2)).toBe(true);
      expect(openSessions(stateFile)).toHaveLength(2);
    } finally {
      child.kill('SIGKILL');
    }
  }, 30_000);
});
