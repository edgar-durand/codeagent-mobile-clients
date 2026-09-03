import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { getIntegration } from '@codeam/shared';

/**
 * Drives the PINNED ClickUp MCP server for real — the exact `command`/`args`
 * the registry hands the `codeam mcp-run` shim — and asserts over `tools/list`
 * that the tools a user actually reaches for are there and NOT behind a
 * paywall.
 *
 * Why this exists: on 2026-09-03 the pinned server (`@taazkareem/…@0.14.4`)
 * connected, found the user's workspace, and then answered "LIMITED" for every
 * tool — the maintainer had gone Proprietary with a licence gate. No test
 * exercised the package itself, so the only thing that caught it was a user.
 * A licence-field audit (`mcp-package-licences.test.ts`) now guards the pin;
 * this test guards what the server actually SERVES, which is the thing the
 * user experiences and the thing a licence field cannot promise.
 *
 * Runs with a dummy token: `tools/list` needs no credential, so a paywall that
 * hides tools shows up here regardless. Network-dependent (npx downloads the
 * pinned package) — gated on RUN_MCP_INT=1, run in CI.
 */

const enabled = process.env.RUN_MCP_INT === '1';

const MUST_HAVE = [
  /workspace.*task|list_tasks|get_tasks/, // read tasks across the workspace
  /^create_task$/,
  /^update_task$/,
  /list_spaces|get_spaces/,
  /comment/,
];

async function listTools(command: string, args: string[], env: Record<string, string>) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c: string) => (out += c));
  child.stderr.on('data', (c: string) => (err += c));
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codeam-test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ];
  child.stdin.write(msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');

  const tools = await new Promise<string[]>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no tools/list answer in 180s. stderr: ${err.slice(-400)}`)), 180_000);
    const tick = setInterval(() => {
      for (const line of out.split('\n')) {
        try {
          const j = JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } };
          if (j.id === 2 && j.result?.tools) {
            clearTimeout(t); clearInterval(tick);
            resolve(j.result.tools.map((x) => x.name));
          }
        } catch { /* partial line */ }
      }
    }, 100);
  }).finally(() => child.kill('SIGKILL'));
  return { tools, stderr: err };
}

describe.runIf(enabled)('the pinned ClickUp MCP server serves the tools users need, unpaywalled', () => {
  it('tools/list exposes task/space/comment tools and mentions no licence', async () => {
    const mcp = getIntegration('clickup').delivery.mcp!;
    expect(mcp.command).toBe('npx');
    const env: Record<string, string> = {};
    // Feed a dummy value into every env var the delivery maps — the server
    // only needs them present to boot; tools/list makes no API call.
    for (const k of Object.keys(mcp.envMapping)) env[k] = 'pk_dummy_for_tools_list';

    const { tools, stderr } = await listTools(mcp.command, mcp.args, env);

    // The whole point: a paywalled build hides or stubs these.
    for (const re of MUST_HAVE) {
      expect(tools.some((t) => re.test(t)), `no tool matching ${re} in: ${tools.join(', ')}`).toBe(true);
    }
    // 0.8.5 of the old server had 36; the paywalled 0.14.4 served a handful.
    // Anything under 30 means we regressed to a crippled build.
    expect(tools.length).toBeGreaterThanOrEqual(30);
    expect(stderr).not.toMatch(/licen[cs]e|paywall|LICENSE_KEY/i);
  }, 200_000);
});
