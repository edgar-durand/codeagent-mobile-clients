/**
 * ACP chrome-leak canary.
 *
 * Spawns the REAL claude ACP adapter (the same `@agentclientprotocol/claude-agent-acp`
 * the CLI ships), drives one trivial turn over ACP JSON-RPC, concatenates every
 * `agent_message_chunk` text delta, and fails if Claude Code TUI chrome leaked
 * into that stream (see chrome-leak-detector.ts). This is the early-warning net
 * for the 2026-07-16 incident: when a NEW Claude Code / adapter version starts
 * streaming its banner/status/box-drawing as text again, this trips BEFORE users
 * hit it — run it on a schedule (CI) and on-demand against a live box.
 *
 * Usage:  npx tsx scripts/acp-chrome-canary.ts
 * Auth:   CodeAgent authenticates claude by PLAN SUBSCRIPTION, not an API key —
 *         so this needs a subscription credential in the env: CLAUDE_CODE_OAUTH_TOKEN
 *         (from `claude setup-token`), or a seeded ~/.claude/.credentials.json (the
 *         OAuth blob a provisioned codespace/box already carries).
 * Exit:   0 = clean, 1 = chrome leaked (prints the offending lines), 2 = harness
 *         error (couldn't reach the model at all — inconclusive, not a leak).
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectTuiChromeLeak } from '../src/agents/acp/chrome-leak-detector';

const PROMPT = process.env.CLAUDE_CANARY_PROMPT ?? 'Reply with exactly one word: pong';
const TIMEOUT_MS = Number(process.env.CLAUDE_CANARY_TIMEOUT_MS ?? 90_000);

function resolveAdapterBin(): string {
  const require = createRequire(import.meta.url);
  // Mirror adapters.ts resolveBin: find the package's bin entry.
  const pkgJson = require.resolve('@agentclientprotocol/claude-agent-acp/package.json');
  const dir = path.dirname(pkgJson);
  const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8')) as { bin?: Record<string, string> | string };
  const rel =
    typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin ?? {})[0] ?? 'dist/acp-agent.js';
  return path.join(dir, rel);
}

async function main(): Promise<number> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-canary-'));
  const bin = resolveAdapterBin();
  const child = spawn(process.execPath, [bin], {
    cwd,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env },
  });

  let buf = '';
  let text = ''; // cumulative agent_message_chunk text
  const pending = new Map<number, (result: unknown) => void>();
  let nextId = 1;

  const send = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        pending.get(msg.id)!(msg.result);
        pending.delete(msg.id);
      } else if (msg.method === 'session/update') {
        const update = (msg.params as { update?: Record<string, unknown> })?.update;
        if (update?.sessionUpdate === 'agent_message_chunk') {
          const content = update.content as { type?: string; text?: string } | undefined;
          if (content?.type === 'text' && typeof content.text === 'string') text += content.text;
        }
      } else if (typeof msg.id === 'number' && msg.method === 'session/request_permission') {
        // No tools in the canary prompt should trigger this; deny to be safe.
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'cancelled' } } })}\n`,
        );
      }
    }
  });

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, TIMEOUT_MS);

  try {
    await send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const newSession = (await send('session/new', { cwd, mcpServers: [] })) as {
      sessionId?: string;
    };
    const sessionId = newSession?.sessionId;
    if (!sessionId) {
      console.error('[canary] session/new returned no sessionId — inconclusive');
      return 2;
    }
    await send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: PROMPT }],
    });
  } catch (err) {
    console.error(`[canary] ACP turn failed (inconclusive): ${(err as Error).message}`);
    return 2;
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
  }

  if (!text.trim()) {
    console.error('[canary] no assistant text captured — inconclusive (auth/model issue?)');
    return 2;
  }

  const hits = detectTuiChromeLeak(text);
  if (hits.length === 0) {
    console.log('[canary] ✓ ACP stream is clean — no Claude Code TUI chrome leaked.');
    return 0;
  }
  console.error(`[canary] ✗ TUI CHROME LEAKED into the ACP stream (${hits.length} line(s)):`);
  for (const h of hits) console.error(`   [${h.marker}] ${h.line}`);
  console.error('\n[canary] A Claude Code / adapter version is streaming chrome as text again.');
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[canary] harness error: ${err?.message ?? err}`);
    process.exit(2);
  },
);
