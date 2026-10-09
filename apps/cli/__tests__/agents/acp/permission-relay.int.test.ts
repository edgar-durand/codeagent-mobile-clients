/**
 * ACP permission request → relay → resolve, end to end over a REAL stdio
 * process boundary (codeagent-fyas item 1).
 *
 * The pieces are the production ones: a real `AcpClient` spawns a fake ACP
 * agent (plain ndjson JSON-RPC in a `node` subprocess), the runner's own
 * permission wiring (`createRunnerPermissionGate`), a real `StreamingState`
 * holding the pending question, a real `AcpPublisher` (only its network POSTs
 * are spied), and the real command dispatch table for `set_mode` and
 * `select_option`. Only the agent and the backend are faked.
 *
 * The invariant: on a MANAGED session (`autoApprovePermissions` true at spawn)
 * the mobile mode toggle decides who answers a tool permission.
 *   - bypass mode   → the CLI auto-answers with the broadest allow option;
 *   - an ask mode   → the prompt is RELAYED to mobile (publishAwaitingAnswer)
 *                     and the agent receives exactly what the user picked.
 * #599 (v2.61.90) made `set_mode` flip `opts.autoApprovePermissions`; the
 * v2.65.14 gate extraction snapshotted that flag at session start, so the
 * toggle became a no-op again (every tool still auto-approved in "manual").
 * The ask-mode case below fails against that snapshot.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { RemoteCommand } from '@codeam/shared';
import { AcpClient } from '../../../src/agents/acp/client';
import type { AdapterSpec } from '../../../src/agents/acp/adapters';
import { AcpPublisher } from '../../../src/agents/acp/publisher';
import {
  StreamingState,
  createRunnerPermissionGate,
  type AcpRunnerOptions,
} from '../../../src/agents/acp/runner';
import {
  dispatchAcpCommand,
  assembleAcpCommandContext,
  type AcpSessionContext,
} from '../../../src/agents/acp/command-handlers';

// A fake ACP agent. Advertises two native modes; on every `session/prompt` it
// asks the client for permission to run a Bash tool, then reports which option
// it was granted as message text and ends the turn.
const FAKE_AGENT = `
import readline from 'node:readline';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let permSeq = 0;
const waiting = new Map(); // permission request id -> { promptId, sessionId }
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (!msg.method && waiting.has(msg.id)) {
    const { promptId, sessionId } = waiting.get(msg.id);
    waiting.delete(msg.id);
    const o = msg.result && msg.result.outcome;
    const granted = o && o.outcome === 'selected' ? o.optionId : 'cancelled';
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'GRANTED:' + granted } } } });
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    return;
  }
  if (msg.id === undefined || !msg.method) return;
  switch (msg.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1,
        agentCapabilities: { promptCapabilities: {}, loadSession: false } } });
      return;
    case 'session/new':
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-perm',
        modes: { currentModeId: 'bypassPermissions', availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'bypassPermissions', name: 'Bypass Permissions' } ] } } });
      return;
    case 'session/prompt': {
      const permId = 'perm-' + (++permSeq);
      waiting.set(permId, { promptId: msg.id, sessionId: msg.params.sessionId });
      send({ jsonrpc: '2.0', id: permId, method: 'session/request_permission', params: {
        sessionId: msg.params.sessionId,
        toolCall: { toolCallId: 'tool-' + permSeq, title: 'Bash', kind: 'execute',
          rawInput: { command: 'ls' } },
        options: [
          { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' } ] } });
      return;
    }
    default:
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
`;

let dir: string;
let agentPath: string;
const savedAutoApprove = process.env.CODEAM_AUTO_APPROVE;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-perm-relay-'));
  agentPath = path.join(dir, 'fake-agent.mjs');
  fs.writeFileSync(agentPath, FAKE_AGENT);
  // A managed (self-hosted) session — the plane where the toggle matters.
  process.env.CODEAM_AUTO_APPROVE = '1';
});

afterAll(() => {
  if (savedAutoApprove === undefined) delete process.env.CODEAM_AUTO_APPROVE;
  else process.env.CODEAM_AUTO_APPROVE = savedAutoApprove;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* best-effort teardown (Windows EBUSY on a just-exited child) */
  }
});

function command(type: string, payload: Record<string, unknown>, id: string): RemoteCommand {
  return { id, sessionId: 's1', pluginId: 'p1', type, payload, status: 'pending', createdAt: Date.now() };
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('ACP permission relay — set_mode decides auto-answer vs relay (real stdio agent)', () => {
  it('bypass auto-answers, an ask mode relays the prompt to mobile and returns the user pick', async () => {
    const adapter: AdapterSpec = {
      command: process.execPath,
      args: [agentPath],
      requiresAgentBinary: 'node',
      waitForBinary: async () => true,
    };
    const opts: AcpRunnerOptions = {
      agent: 'claude',
      sessionId: 's1',
      pluginId: 'p1',
      pluginAuthToken: 'tok',
      adapter,
      cwd: dir,
      autoApprovePermissions: true, // managed spawn (CODEAM_AUTO_APPROVE)
    };

    const publisher = new AcpPublisher({
      sessionId: 's1',
      pluginId: 'p1',
      pluginAuthToken: 'tok',
      apiBaseUrl: 'https://api.example.test',
    });
    const publishAwaitingAnswer = vi
      .spyOn(publisher, 'publishAwaitingAnswer')
      .mockResolvedValue(undefined);
    vi.spyOn(publisher, 'publishOutput').mockResolvedValue(undefined);
    vi.spyOn(publisher, 'publishStreamingChunk').mockResolvedValue(undefined);
    const streaming = new StreamingState(publisher);

    const granted: string[] = [];
    const client = new AcpClient({
      adapter,
      cwd: dir,
      onSessionUpdate: (n: SessionNotification) => {
        const u = n.update as { sessionUpdate?: string; content?: { text?: string } };
        const m = u.sessionUpdate === 'agent_message_chunk' ? /^GRANTED:(.+)$/.exec(u.content?.text ?? '') : null;
        if (m) granted.push(m[1]);
      },
      onRequestPermission: createRunnerPermissionGate(opts, publisher, streaming),
    });

    const relay = { sendResult: vi.fn(async () => undefined) };
    // Partial context: set_mode and a permission select_option only read these.
    const session = {
      client,
      relay,
      acpSessionId: 'sess-perm',
      streaming,
      opts,
      publisher,
    } as unknown as AcpSessionContext;
    const dispatch = (cmd: RemoteCommand) =>
      dispatchAcpCommand(assembleAcpCommandContext(session, cmd));

    try {
      await client.start();

      // 1) Bypass (the spawn default): auto-answered, nothing reaches mobile.
      await client.prompt('list the files');
      expect(granted).toEqual(['allow_always']);
      expect(publishAwaitingAnswer).not.toHaveBeenCalled();

      // 2) The user flips the session to an ask mode from the phone.
      await dispatch(command('set_mode', { modeId: 'default' }, 'c-mode-1'));
      expect(relay.sendResult).toHaveBeenLastCalledWith('c-mode-1', 'completed', { modeId: 'default' });
      expect(opts.autoApprovePermissions).toBe(false);

      // 3) The next tool permission is RELAYED; the agent gets the user's pick.
      const turn = client.prompt('list them again');
      await waitFor(() => publishAwaitingAnswer.mock.calls.length === 1, 'the relayed permission prompt');
      const event = publishAwaitingAnswer.mock.calls[0][0] as { questionId: string };
      expect(event.questionId).toBeTruthy();
      await dispatch(command('select_option', { optionId: 'reject' }, 'c-pick-1'));
      expect(relay.sendResult).toHaveBeenLastCalledWith('c-pick-1', 'completed', {});
      await turn;
      expect(granted).toEqual(['allow_always', 'reject']);

      // 4) Back to bypass: auto-answered again, no new relay.
      await dispatch(command('set_mode', { modeId: 'bypassPermissions' }, 'c-mode-2'));
      await client.prompt('one more time');
      expect(granted).toEqual(['allow_always', 'reject', 'allow_always']);
      expect(publishAwaitingAnswer).toHaveBeenCalledTimes(1);
    } finally {
      await client.stop().catch(() => undefined);
    }
  }, 30_000);
});
