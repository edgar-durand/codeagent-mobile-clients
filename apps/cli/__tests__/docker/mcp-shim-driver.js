// mcp-shim-driver.js — runs INSIDE the mcp-shim.Dockerfile container.
//
// Drives the REAL `codeam mcp-run jira` end-to-end against the REAL (pinned)
// mcp-atlassian, with only the CodeAgent backend faked:
//
//   1. Starts a fake broker (node http server) on 127.0.0.1:8399 that answers
//      POST /api/plugin/integrations/jira/token — first call returns tok-1
//      with a NEAR expiry (~6 min, inside the shim's 30 s-tick restart window
//      after ~90 s), every later call returns tok-2 with a far expiry (+1 h).
//   2. Writes ~/.codeam/integrations.json WITHOUT staticEnv — deliberately
//      mimicking a manifest emitted by a pre-staticEnv backend (≤ 2.60.46) so
//      the run also proves the shim's rollout defense (bundled-registry
//      staticEnv merged underneath → ATLASSIAN_OAUTH_ENABLE=true still set).
//   3. Spawns `codeam mcp-run jira` with the CODEAM_MCP_* env contract and
//      CODEAM_API_URL pointed at the fake broker.
//   4. initialize → notifications/initialized → tools/list over stdio and
//      asserts a real jira tool list comes back (dummy creds are fine —
//      mcp-atlassian validates credentials lazily, at tool CALL time).
//   5. Scans /proc: the token must appear ONLY in the mcp-atlassian process
//      env, NEVER in any process argv.
//   6. Waits for the expiry-driven restart (fake broker sees a 2nd token
//      request) and asserts a post-restart tools/list still answers.
//
// Output: progress markers on stderr; ONE final JSON result line on stdout.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const BROKER_PORT = 8399;
const MCP_PIN = process.env.MCP_ATLASSIAN_PIN || 'mcp-atlassian==0.22.1';
/** tok-1 expiry: 6 min out → crosses the shim's 5-min restart-ahead window
 *  after ~60 s → the 30 s restart tick swaps the child at ~90 s. */
const NEAR_EXPIRY_MS = 6 * 60 * 1000;
const RESTART_DEADLINE_MS = 240_000;

const progress = (msg) => process.stderr.write(`[driver] ${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fake broker ───────────────────────────────────────────────────────────────
let brokerCalls = 0;
const brokerSeenHeaders = [];
function startBroker() {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/plugin/integrations/jira/token') {
      brokerCalls += 1;
      brokerSeenHeaders.push(req.headers['x-plugin-auth-token'] || '');
      const first = brokerCalls === 1;
      const data = {
        accessToken: first ? 'tok-1' : 'tok-2',
        expiresAt: new Date(Date.now() + (first ? NEAR_EXPIRY_MS : 60 * 60 * 1000)).toISOString(),
        cloudId: 'cl-1',
      };
      progress(`broker call #${brokerCalls} → ${data.accessToken} (expires ${data.expiresAt})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data }));
      return;
    }
    res.writeHead(404).end('{"success":false}');
  });
  return new Promise((resolve) => server.listen(BROKER_PORT, '127.0.0.1', () => resolve(server)));
}

// ── /proc scans (token must ride env, never argv) ─────────────────────────────
function scanProc(token) {
  let envPids = [];
  let argvPids = [];
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    let environ = '';
    let cmdline = '';
    try {
      environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      continue; // process raced away
    }
    const argv = cmdline.split('\0').join(' ');
    if (environ.includes(`ATLASSIAN_OAUTH_ACCESS_TOKEN=${token}`)) envPids.push({ pid, argv });
    if (argv.includes(token)) argvPids.push({ pid, argv });
  }
  return { envPids, argvPids };
}

// ── JSON-RPC over the shim's stdio ────────────────────────────────────────────
function makeRpc(child) {
  const pending = new Map(); // id → resolve
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  return {
    request(id, method, params, timeoutMs) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(
          () => {
            pending.delete(id);
            reject(new Error(`rpc id=${id} (${method}) timed out after ${timeoutMs}ms`));
          },
          timeoutMs,
        );
        pending.set(id, (msg) => {
          clearTimeout(t);
          resolve(msg);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
  };
}

async function main() {
  const checks = {};

  await startBroker();
  progress(`fake broker listening on :${BROKER_PORT}`);

  // Manifest WITHOUT staticEnv — mimics a ≤2.60.46 backend (rollout defense).
  const manifestDir = path.join(os.homedir(), '.codeam');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, 'integrations.json'),
    JSON.stringify(
      {
        integrations: [
          {
            id: 'jira',
            delivery: {
              mcp: {
                command: 'uvx',
                args: [MCP_PIN],
                envMapping: {
                  ATLASSIAN_OAUTH_ACCESS_TOKEN: 'accessToken',
                  ATLASSIAN_OAUTH_CLOUD_ID: 'cloudId',
                },
                // NO staticEnv — the shim must backfill ATLASSIAN_OAUTH_ENABLE
                // from its bundled registry or the server lists ZERO tools.
              },
            },
          },
        ],
      },
      null,
      2,
    ),
  );
  progress('manifest written (no staticEnv — pre-staticEnv backend shape)');

  const child = spawn('codeam', ['mcp-run', 'jira'], {
    env: {
      ...process.env,
      CODEAM_MCP_INTEGRATION_ID: 'jira',
      CODEAM_MCP_SESSION_ID: 'sess-int-1',
      CODEAM_MCP_PLUGIN_ID: 'plugin-int-1',
      CODEAM_MCP_PLUGIN_TOKEN: 'plug-auth-token-1',
      CODEAM_API_URL: `http://127.0.0.1:${BROKER_PORT}`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[shim] ${d}`));
  const childExit = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const rpc = makeRpc(child);

  try {
    // ── initialize + tools/list against the tok-1 child ─────────────────────
    progress('sending initialize (first uvx spawn — warm cache, may take ~10s)…');
    const init = await rpc.request(
      1,
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcp-shim-int', version: '0' },
      },
      120_000,
    );
    checks.initializeOk = Boolean(init.result && init.result.serverInfo);
    checks.serverName = init.result?.serverInfo?.name ?? null;
    rpc.notify('notifications/initialized');

    const tools1 = await rpc.request(2, 'tools/list', undefined, 60_000);
    const names1 = (tools1.result?.tools ?? []).map((t) => t.name);
    checks.toolCount = names1.length;
    checks.jiraToolCount = names1.filter((n) => n.startsWith('jira_')).length;
    checks.hasJiraGetIssue = names1.includes('jira_get_issue');
    progress(`tools/list #1 → ${names1.length} tools (${checks.jiraToolCount} jira_*)`);

    // ── token placement: env yes, argv never ────────────────────────────────
    const scan1 = scanProc('tok-1');
    checks.tok1InChildEnv = scan1.envPids.length > 0;
    checks.tok1EnvArgvs = scan1.envPids.map((p) => p.argv.slice(0, 80));
    checks.tok1ArgvLeak = scan1.argvPids.length > 0;
    // Belt-and-braces: the brief's literal `ps` form.
    const psOut = require('node:child_process').execFileSync('ps', ['-eo', 'args'], {
      encoding: 'utf8',
    });
    checks.tok1InPsArgs = psOut.includes('tok-1');
    progress(
      `tok-1 placement: env pids=${scan1.envPids.length}, argv leaks=${scan1.argvPids.length}, ps-args leak=${checks.tok1InPsArgs}`,
    );

    // ── expiry-driven restart ────────────────────────────────────────────────
    progress('waiting for the expiry-driven restart (2nd broker call; ~90–120 s)…');
    const deadline = Date.now() + RESTART_DEADLINE_MS;
    while (brokerCalls < 2 && Date.now() < deadline) await sleep(2_000);
    checks.brokerCalls = brokerCalls;
    checks.restartTriggered = brokerCalls >= 2;
    if (!checks.restartTriggered) throw new Error('restart never triggered within deadline');

    // Give the swapped-in child a beat to finish the sentinel-initialize
    // handshake (warm uvx spawn ≈ a few seconds).
    await sleep(10_000);

    const tools2 = await rpc.request(3, 'tools/list', undefined, 90_000);
    const names2 = (tools2.result?.tools ?? []).map((t) => t.name);
    checks.postRestartToolCount = names2.length;
    checks.postRestartOk = names2.length > 0 && names2.includes('jira_get_issue');
    progress(`tools/list #2 (post-restart) → ${names2.length} tools`);

    const scan2 = scanProc('tok-2');
    checks.tok2InChildEnv = scan2.envPids.length > 0;
    checks.tok2ArgvLeak = scan2.argvPids.length > 0;
    // The old tok-1 child must be gone (its env would still show tok-1).
    const scan1After = scanProc('tok-1');
    checks.tok1ChildGone = scan1After.envPids.length === 0;
    progress(
      `tok-2 placement: env pids=${scan2.envPids.length}, argv leaks=${scan2.argvPids.length}; tok-1 child gone=${checks.tok1ChildGone}`,
    );

    const ok =
      checks.initializeOk &&
      checks.jiraToolCount > 0 &&
      checks.hasJiraGetIssue &&
      checks.tok1InChildEnv &&
      !checks.tok1ArgvLeak &&
      !checks.tok1InPsArgs &&
      checks.restartTriggered &&
      checks.postRestartOk &&
      checks.tok2InChildEnv &&
      !checks.tok2ArgvLeak &&
      checks.tok1ChildGone;

    process.stdout.write(JSON.stringify({ ok, checks }) + '\n');
    process.exitCode = ok ? 0 : 1;
  } catch (err) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err), checks }) + '\n',
    );
    process.exitCode = 1;
  } finally {
    child.kill('SIGKILL');
    await Promise.race([childExit, sleep(3_000)]);
    process.exit(process.exitCode ?? 1);
  }
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err) }) + '\n');
  process.exit(1);
});
