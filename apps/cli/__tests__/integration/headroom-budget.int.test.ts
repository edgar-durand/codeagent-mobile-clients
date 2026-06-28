/**
 * Headroom budget — REAL integration test.
 *
 * This is NOT a unit test. It proves the headroom budget enforcement behaviour
 * end-to-end against a REAL headroom proxy process:
 *
 *   1. Start `headroom proxy --port <free> --budget 0.00 --budget-period daily`
 *      (all budget consumed immediately — every request is rejected).
 *   2. Send a minimal POST /v1/messages through it; assert a real HTTP 429 and
 *      that `looksLikeBudgetExceeded` matches the actual response body.
 *   3. Smoke-assert that a proxy started WITH `buildBudgetProxyArgs` flags
 *      reports `cost.budget_limit_usd` / `cost.budget_period` at `/stats`.
 *
 * ── Gating ──────────────────────────────────────────────────────────────────
 * Skipped UNLESS `RUN_HEADROOM_BUDGET_INT=1` is set AND `headroom` is on PATH.
 * The default `npm run test` NEVER requires a live headroom install; the gate
 * only fires when a developer explicitly opts in:
 *
 *   RUN_HEADROOM_BUDGET_INT=1 npx vitest run integration/headroom-budget
 *
 * ── Why this test exists ─────────────────────────────────────────────────────
 * `looksLikeBudgetExceeded` and `buildBudgetProxyArgs` are unit-tested against
 * hardcoded strings/maps, but only a REAL headroom proxy proves that:
 *   · the actual 429 body format matches our regex (a format change in headroom
 *     would silently break recovery without this test).
 *   · the proxy actually starts with the budget flags produced by
 *     `buildBudgetProxyArgs` and correctly reports them on `/stats`.
 *
 * ── Mirrors ──────────────────────────────────────────────────────────────────
 * The skip gate, logging pattern, and phase structure mirror
 * `headroom-provision.int.test.ts` exactly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as net from 'node:net';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';

// ── Gate checks ──────────────────────────────────────────────────────────────
// Probed synchronously at module load — consistent with headroom-provision.int.test.ts
// and host-agent.docker.e2e.test.ts (no top-level await).

const RUN_HEADROOM_BUDGET_INT = process.env.RUN_HEADROOM_BUDGET_INT === '1';

function probeHeadroomSync(): boolean {
  if (!RUN_HEADROOM_BUDGET_INT) return false;
  try {
    execFileSync('headroom', ['--version'], { timeout: 10_000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const headroomAvailable = probeHeadroomSync();

// Inform the developer (once, non-failing) why this suite was skipped.
if (!RUN_HEADROOM_BUDGET_INT) {
  // eslint-disable-next-line no-console
  console.log(
    '[headroom-budget] SKIPPED — set RUN_HEADROOM_BUDGET_INT=1 (and have headroom on PATH) to run the real-proxy gate.',
  );
} else if (!headroomAvailable) {
  // eslint-disable-next-line no-console
  console.log(
    '[headroom-budget] SKIPPED — RUN_HEADROOM_BUDGET_INT=1 but `headroom --version` failed (not installed).',
  );
}

// ── Imports of the modules under test ────────────────────────────────────────
// Imported unconditionally so the module graph is type-checked even when the
// suite is skipped — mirrors the beads-configure.int.test.ts pattern.
import { looksLikeBudgetExceeded } from '../../src/agents/acp/budgetRecovery';
import { buildBudgetProxyArgs } from '../../src/services/headroom/budget-args';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Find a free TCP port by binding to port 0 then releasing it. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          reject(new Error('Could not determine free port'));
        }
      });
    });
    srv.once('error', reject);
  });
}

/** Wait until the headroom proxy is accepting HTTP connections on the given port. */
function waitForProxy(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function attempt() {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/readyz', method: 'GET', timeout: 500 },
        (res) => {
          res.resume();
          resolve();
        },
      );
      req.once('error', () => {
        if (Date.now() >= deadline) {
          reject(new Error(`headroom proxy on :${port} did not become ready within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 200);
        }
      });
      req.end();
    }
    attempt();
  });
}

/** GET a path on the proxy and return { status, body }. */
function proxyGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.once('error', reject);
    req.end();
  });
}

/** POST to /v1/messages and return { status, body }. */
function postMessages(port: number): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify({
    model: 'claude-haiku-3-5-20241022',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'anthropic-version': '2023-06-01',
          'x-api-key': 'test-key-int',
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.once('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Suite state ───────────────────────────────────────────────────────────────

/** Tracks all proxy child processes so afterAll can clean them up. */
const proxyProcesses: ReturnType<typeof spawn>[] = [];

/** Start a headroom proxy on the given port with optional extra args. */
function startProxy(port: number, extraArgs: string[] = []): ReturnType<typeof spawn> {
  const proxyEnv = { ...process.env, HEADROOM_KOMPRESS_BACKEND: 'onnx_cpu' };
  const proc = spawn(
    'headroom',
    ['proxy', '--port', String(port), '--no-optimize', '--stateless', ...extraArgs],
    {
      stdio: 'ignore',
      detached: false,
      env: proxyEnv,
    },
  );
  // Consume errors so Node doesn't emit an unhandled rejection if the proxy
  // fails to start (we surface it via the readiness check instead).
  proc.once('error', (err) => {
    // eslint-disable-next-line no-console
    console.warn(`[headroom-budget] proxy on :${port} error: ${err.message}`);
  });
  proxyProcesses.push(proc);
  return proc;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

const suite = RUN_HEADROOM_BUDGET_INT && headroomAvailable ? describe : describe.skip;

suite('headroom budget — real proxy integration', () => {
  afterAll(() => {
    // Kill all proxy processes regardless of test outcome — nothing lingers.
    for (const proc of proxyProcesses) {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* best-effort */
      }
    }
    proxyProcesses.length = 0;
  });

  // ── Phase 1: zero-budget proxy → real 429 + looksLikeBudgetExceeded ────────

  it(
    'proxy started with --budget 0.00 returns HTTP 429 and looksLikeBudgetExceeded matches the body',
    async () => {
      const port = await getFreePort();
      // eslint-disable-next-line no-console
      console.log(`[headroom-budget] starting zero-budget proxy on :${port}`);

      startProxy(port, ['--budget', '0.00', '--budget-period', 'daily']);
      await waitForProxy(port, 10_000);

      // eslint-disable-next-line no-console
      console.log(`[headroom-budget] proxy ready on :${port} — sending POST /v1/messages`);
      const { status, body } = await postMessages(port);

      // eslint-disable-next-line no-console
      console.log(`[headroom-budget] response: HTTP ${status} — body: ${body}`);

      // Real 429.
      expect(status).toBe(429);

      // The body must be parseable JSON with a `detail` field.
      const parsed = JSON.parse(body) as { detail?: string };
      expect(typeof parsed.detail).toBe('string');

      // looksLikeBudgetExceeded must match the ACTUAL body string as-is.
      // If headroom changes the 429 body format, this test will catch it.
      expect(looksLikeBudgetExceeded(body)).toBe(true);

      // Also verify it matches when given just the detail string
      // (runner passes `error.detail ?? responseText` to looksLikeBudgetExceeded).
      expect(looksLikeBudgetExceeded(parsed.detail ?? '')).toBe(true);
    },
    30_000,
  );

  // ── Phase 2: buildBudgetProxyArgs flags appear in /stats ──────────────────

  it(
    'proxy started via buildBudgetProxyArgs({HEADROOM_BUDGET:"10",HEADROOM_BUDGET_PERIOD:"daily"}) reports cost.budget_limit_usd and cost.budget_period at /stats',
    async () => {
      const port = await getFreePort();

      // Build the flags the same way host-agent.ts does.
      const budgetArgs = buildBudgetProxyArgs({
        HEADROOM_BUDGET: '10',
        HEADROOM_BUDGET_PERIOD: 'daily',
      });

      // Smoke: the args are correct (already unit-tested; belt+suspenders).
      expect(budgetArgs).toEqual(['--budget', '10', '--budget-period', 'daily']);

      // eslint-disable-next-line no-console
      console.log(`[headroom-budget] starting budget-10 proxy on :${port} with args: ${budgetArgs.join(' ')}`);
      startProxy(port, budgetArgs);
      await waitForProxy(port, 10_000);

      const { status, body } = await proxyGet(port, '/stats');
      expect(status).toBe(200);

      const stats = JSON.parse(body) as {
        cost?: { budget_limit_usd?: number; budget_period?: string };
      };

      // eslint-disable-next-line no-console
      console.log(`[headroom-budget] /stats cost: ${JSON.stringify(stats.cost)}`);

      // The proxy must report the budget settings from the flags we passed.
      expect(stats.cost?.budget_limit_usd).toBe(10);
      expect(stats.cost?.budget_period).toBe('daily');
    },
    30_000,
  );
});
