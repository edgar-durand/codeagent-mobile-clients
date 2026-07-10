/**
 * REAL integration test for the ACP-start ETXTBSY retry.
 *
 * Reproduces the production incident (edgar-ph codespace, 2026-07-08): the
 * `@agentclientprotocol/claude-agent-acp` adapter handshakes fine, then — when
 * it execs the ~250MB SDK-bundled `claude` binary during `session/new` — that
 * binary is momentarily open-for-write on a fresh/waking codespace, so the
 * adapter rejects `newSession` with `-32603 … { details: 'spawn ETXTBSY' }`.
 * The user saw "The claude agent failed to start · spawn ETXTBSY"; a later wake
 * self-recovered — a transient race.
 *
 * This test does NOT mock spawn. It launches a REAL `node` subprocess running a
 * fake adapter that speaks the actual ndjson ACP protocol over stdio, fails the
 * first `session/new` exactly like the real adapter, and succeeds on the retry.
 * It asserts:
 *   1. AcpClient.start() transparently retries the transient failure and
 *      returns the session (the error never reaches the user), and
 *   2. a NON-transient error (auth) is NOT retried — it fails on attempt 1.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AcpClient, _acpStartSeam } from '../../../src/agents/acp/client';
import type { AcpClientOptions } from '../../../src/agents/acp/client';

const NODE = process.execPath;

// A minimal ACP adapter: ndjson JSON-RPC over stdio. Responds to `initialize`,
// then on the FIRST session-creating request fails per `mode`; on later ones it
// succeeds. A counter file makes "attempt N" survive across respawns.
const FAKE_ADAPTER = `
import readline from 'node:readline';
import fs from 'node:fs';
const counterFile = process.argv[2];
const mode = process.argv[3] || 'etxtbsy-then-ok';
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');

// module-crash-then-ok: reproduce the 2026-07-10 codespace incident — the
// adapter itself CRASHES AT IMPORT (ERR_MODULE_NOT_FOUND on a still-installing
// dep) the FIRST time it's spawned, exiting BEFORE it can answer 'initialize'.
// The counter is bumped per PROCESS SPAWN (not per session/new) for this mode.
if (mode === 'module-crash-then-ok') {
  let n = 0;
  try { n = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0; } catch {}
  n += 1;
  fs.writeFileSync(counterFile, String(n));
  if (n === 1) {
    process.stderr.write('node:internal/modules/esm/resolve:275\\n');
    process.stderr.write("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/x/@anthropic-ai/claude-agent-sdk/sdk.mjs' imported from /x/@agentclientprotocol/claude-agent-acp/dist/index.js\\n");
    process.exit(1);
  }
  // n >= 2: the install settled — speak the protocol and succeed.
  const rl2 = readline.createInterface({ input: process.stdin });
  rl2.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined || !msg.method) return;
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: {}, loadSession: false },
      }});
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-ok-' + n } });
  });
} else {

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || !msg.method) return; // ignore notifications
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: {}, loadSession: false },
    }});
    return;
  }
  // Anything else during start() is the session-creating request (session/new).
  let n = 0;
  try { n = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0; } catch {}
  n += 1;
  fs.writeFileSync(counterFile, String(n));
  if (mode === 'always-auth') {
    process.stderr.write('Not logged in. Please run /login\\n');
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Authentication required' } });
    return;
  }
  if (n === 1) {
    // The real adapter logs the internal cause to stderr while returning a
    // generic -32603 — reproduce BOTH signals the detector keys on.
    process.stderr.write("newSession failed: { code: -32603, data: { details: 'spawn ETXTBSY' } }\\n");
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error', data: { details: 'spawn ETXTBSY' } } });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-ok-' + n } });
  }
});
}
`;

let dir: string;
let adapterPath: string;
let realSleep: typeof _acpStartSeam.sleep;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-etxtbsy-'));
  adapterPath = path.join(dir, 'fake-adapter.mjs');
  fs.writeFileSync(adapterPath, FAKE_ADAPTER);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  realSleep = _acpStartSeam.sleep;
  _acpStartSeam.sleep = async () => undefined; // instant backoff under test
});
afterEach(() => {
  _acpStartSeam.sleep = realSleep;
});

function makeClient(counterFile: string, mode: string): AcpClient {
  const opts: AcpClientOptions = {
    adapter: {
      command: NODE,
      args: [adapterPath, counterFile, mode],
    } as unknown as AcpClientOptions['adapter'],
    cwd: dir,
    onSessionUpdate: () => undefined,
    onRequestPermission: (async () => ({
      outcome: { outcome: 'cancelled' },
    })) as unknown as AcpClientOptions['onRequestPermission'],
  };
  return new AcpClient(opts);
}

describe('AcpClient.start — transient adapter ETXTBSY retry (real subprocess)', () => {
  it('retries a -32603 spawn-ETXTBSY newSession failure and starts on the next attempt', async () => {
    const counter = path.join(dir, `c-${Date.now()}-a`);
    const client = makeClient(counter, 'etxtbsy-then-ok');
    try {
      const res = await client.start();
      expect(res.sessionId).toMatch(/^sess-ok-/);
      // Exactly two adapter session/new attempts: the ETXTBSY failure + the retry.
      expect(fs.readFileSync(counter, 'utf8')).toBe('2');
    } finally {
      await client.stop().catch(() => undefined);
    }
  });

  it('retries an adapter that CRASHES AT IMPORT (ERR_MODULE_NOT_FOUND) and starts on the next spawn', async () => {
    // 2026-07-10 incident: on a fresh codespace `claude-agent-acp` imported
    // `@anthropic-ai/claude-agent-sdk/sdk.mjs` mid-atomic-rename → the adapter
    // process exited at load with ERR_MODULE_NOT_FOUND, BEFORE answering
    // `initialize`. Every codespace claude deploy died "The claude agent failed
    // to start". start() must classify the import crash as transient + respawn.
    const counter = path.join(dir, `c-${Date.now()}-mc`);
    const client = makeClient(counter, 'module-crash-then-ok');
    try {
      const res = await client.start();
      expect(res.sessionId).toMatch(/^sess-ok-/);
      // Two spawns: the import-crash + the retry that succeeds.
      expect(fs.readFileSync(counter, 'utf8')).toBe('2');
    } finally {
      await client.stop().catch(() => undefined);
    }
  });

  it('does NOT retry a non-transient (auth) failure — fails on the first attempt', async () => {
    const counter = path.join(dir, `c-${Date.now()}-b`);
    const client = makeClient(counter, 'always-auth');
    try {
      await expect(client.start()).rejects.toThrow(/Authentication required|Internal error|auth/i);
      // Only one attempt — an auth error must surface immediately, not retry x5.
      expect(fs.readFileSync(counter, 'utf8')).toBe('1');
    } finally {
      await client.stop().catch(() => undefined);
    }
  });
});
