#!/usr/bin/env node
// Test fixture: a minimal line-delimited JSON-RPC "MCP server" used to drive
// RestartableStdioProxy tests against a REAL child process (no network, fully
// deterministic). Not production code — do not import from src/.
//
// Behavior:
//   - `initialize` request -> replies with
//       { id, result: { instance: INSTANCE_TAG ?? 'one', token: FAKE_TOKEN ?? '' } }
//   - `tools/list` request -> replies with a canned result echoing FAKE_TOKEN
//   - any other message with a `method` and an `id` -> generic echo reply
//   - notifications (no `id`) are ignored
//   - exits cleanly (code 0) when stdin closes

const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

// Support for the proxy's "in-flight" test: a `hold` request is NOT answered
// immediately (it stays "in flight" from the proxy's point of view); a
// `release` notification (no `id`, so it's itself ignored by the generic
// notification rule below — it's special-cased first) flushes replies to
// every held request.
const held = [];

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore malformed lines
  }

  if (msg.method === 'release') {
    for (const id of held.splice(0)) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { released: true } }) + '\n');
    }
    return;
  }

  // Notifications carry no `id` — never reply to those.
  if (msg.id === undefined) return;

  if (msg.method === 'hold') {
    held.push(msg.id);
    return; // deliberately no reply — the request stays "in flight"
  }

  if (msg.method === 'initialize') {
    const result = {
      instance: process.env.INSTANCE_TAG ?? 'one',
      token: process.env.FAKE_TOKEN ?? '',
    };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    return;
  }

  if (msg.method === 'tools/list') {
    const result = { tools: [{ name: 'echo-token', token: process.env.FAKE_TOKEN ?? '' }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    return;
  }

  // Generic echo for any other request so "unknown request in-flight
  // tracking" tests have something to respond to.
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echo: msg.method ?? null } }) + '\n',
  );
});

rl.on('close', () => {
  process.exit(0);
});
