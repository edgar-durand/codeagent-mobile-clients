/**
 * beads_configure — gated integration smoke test.
 *
 * Gating ─────────────────────────────────────────────────────────────────────
 * Skipped UNLESS `RUN_BEADS_INT=1` is set. The default `npm run test` never
 * requires real bd/dolt, network access, or a live dolt sql-server; the gate
 * only fires for explicit integration runs.
 *
 * What this test proves (when enabled) ───────────────────────────────────────
 * The test exercises the full `configureBeads` round-trip end-to-end through
 * the real config-store (a temp HOME), wiring real dep implementations for all
 * side-effectful slots except the heavy bd/dolt provisioner (which needs a live
 * dolt sql-server and is covered by the Docker E2E suite).  The real file-system
 * primitives exercised here are:
 *
 *   · `persistBeadsConfig` / `readBeadsEnabled` (the real config-store on a
 *     temp dir, not mocked — proves the JSON round-trip under the HOME redirect)
 *   · The three `configureBeads` action branches ('status' → 'enable' → 'disable')
 *     wired through the same dependency interface as the production handler
 *   · status: calls probe, returns running=true when bdAvailable+serverUp
 *   · enable: persists enabled:true, calls provision, starts watcher, emits enabled
 *   · disable: persists enabled:false, stops watcher, reverts hook, emits disabled
 *
 * The parts deliberately skipped (need real bd/dolt) ─────────────────────────
 *   · The actual `provisionBeads` function (heavy: installs bd, starts dolt sql-server)
 *   · The actual `BeadsWatcher` chokidar loop (needs a real `.beads/` feed file)
 *   · `revertAgentHook` against a live agent config (e.g. ~/.claude/settings.json)
 * Those remain as clearly annotated stubs with `TODO: exercise real bd binary`.
 *
 * Mirrors headroom-provision.int.test.ts ─────────────────────────────────────
 * The skip gate, logging pattern, and phase structure mirror the Headroom Docker
 * integration test (`headroom-provision.int.test.ts`) exactly; future authors
 * should keep the two in sync as both are extended.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── Gate ─────────────────────────────────────────────────────────────────────
// Probed synchronously (same pattern as headroom-provision.int.test.ts and
// host-agent.docker.e2e.test.ts) — no top-level await.
const RUN_BEADS_INT = process.env.RUN_BEADS_INT === '1';

if (!RUN_BEADS_INT) {
  // eslint-disable-next-line no-console
  console.log(
    '[beads-configure] SKIPPED — set RUN_BEADS_INT=1 to run the real config-store integration gate.',
  );
}

// ── Imports ───────────────────────────────────────────────────────────────────
// Imported unconditionally so the module graph is type-checked even when the
// suite is skipped.  The heavy provisioner is not imported here — tests stub it.
import { configureBeads, type ConfigureBeadsDeps, type ConfigureBeadsCtx } from '../../src/beads/configure';
import { persistBeadsConfig, readBeadsEnabled, beadsConfigPath } from '../../src/beads/config-store';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a temp dir and redirect HOME so the real config-store writes there. */
function makeTempHome(): { home: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beads-int-'));
  return {
    home,
    cleanup: () => {
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    },
  };
}

/**
 * Build a ConfigureBeadsDeps whose heavy slots (provision, startWatcher,
 * revertAgentHook) are fast stubs — these need a real dolt server.
 * The config-store slots (persist, readEnabled) are the REAL implementations
 * redirected to the temp HOME.
 */
function makeDeps(overrides: Partial<ConfigureBeadsDeps> = {}): ConfigureBeadsDeps & { emitted: unknown[] } {
  const emitted: unknown[] = [];
  return {
    provision: async () => ({
      bdAvailable: true,
      doltAvailable: true,
      serverUp: true,
      prefix: 'inttest_proj',
      // TODO: replace stub with real provisionBeads() + BEADS_DIR temp redirect
      //       once the Docker-based bd+dolt layer is available (RUN_BEADS_INT
      //       gates that heavier path in headroom-provision.int.test.ts style).
    }),
    startWatcher: async () => {
      // TODO: wire real BeadsWatcher once a live feed file is available.
    },
    stopWatcher: async () => {
      // TODO: wire real BeadsWatcher.stop() here.
    },
    probe: async () => ({
      bdAvailable: true,
      doltAvailable: true,
      serverUp: true,
      prefix: 'inttest_proj',
      // TODO: replace stub with real BdAdapter probe once bd binary is present.
    }),
    revertAgentHook: async (_agent: string) => {
      // TODO: wire real wiring.removeBeadsHook() once agent config exists.
    },
    // Real config-store — the key integration assertion of this suite.
    persist: (cfg) => persistBeadsConfig(cfg),
    readEnabled: () => readBeadsEnabled(),
    emit: (event) => emitted.push(event),
    ...overrides,
    // Attach emitted array for assertions — must come after overrides spread
    // so callers can inspect it.
    get emitted() { return emitted; },
  } as ConfigureBeadsDeps & { emitted: unknown[] };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

const suite = RUN_BEADS_INT ? describe : describe.skip;

suite('beads_configure integration — real config-store round-trip', () => {
  let tempHome: ReturnType<typeof makeTempHome>;
  let originalHome: string | undefined;

  beforeAll(() => {
    tempHome = makeTempHome();
    // Redirect HOME so persistBeadsConfig / readBeadsEnabled write/read the
    // temp dir instead of the developer's real ~/.codeam/beads-config.json.
    originalHome = process.env.HOME;
    process.env.HOME = tempHome.home;
    // eslint-disable-next-line no-console
    console.log(`[beads-configure] temp HOME: ${tempHome.home}`);
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    tempHome.cleanup();
  });

  const ctx: ConfigureBeadsCtx = {
    agent: 'claude',
    cwd: '/tmp/fake-project',
    pluginAuthToken: 'test-tok',
  };

  // ── Phase 0: initial status ──────────────────────────────────────────────

  it('status — no config file yet → readEnabled() defaults to true → probe() called → running:true', async () => {
    // No config file exists yet — `readBeadsEnabled` returns true (default-on).
    expect(fs.existsSync(beadsConfigPath())).toBe(false);

    const deps = makeDeps();
    const result = await configureBeads('status', ctx, deps);

    expect(result.enabled).toBe(true);
    expect(result.running).toBe(true);

    const events = deps.emitted;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'beads_status', state: 'enabled' });
  });

  // ── Phase 1: enable ───────────────────────────────────────────────────────

  it('enable — persists enabled:true on real config-store, emits enabled, returns running:true', async () => {
    const deps = makeDeps();
    const result = await configureBeads('enable', ctx, deps);

    // Verify the real config file was written.
    expect(fs.existsSync(beadsConfigPath())).toBe(true);
    const raw = fs.readFileSync(beadsConfigPath(), 'utf8');
    const cfg = JSON.parse(raw) as { enabled: boolean };
    expect(cfg.enabled).toBe(true);

    // Verify configureBeads returned the right shape.
    expect(result.enabled).toBe(true);
    expect(result.running).toBe(true);

    // Verify the real readEnabled() reflects the written state.
    expect(readBeadsEnabled()).toBe(true);

    // Verify events.
    const events = deps.emitted;
    expect(events).toHaveLength(2); // provisioning → enabled
    expect(events[0]).toMatchObject({ type: 'beads_status', state: 'provisioning' });
    expect(events[1]).toMatchObject({ type: 'beads_status', state: 'enabled', running: true });
  });

  // ── Phase 2: status after enable ─────────────────────────────────────────

  it('status — after enable → readEnabled()=true → probe() called → running:true', async () => {
    // Config file now exists from Phase 1.
    expect(fs.existsSync(beadsConfigPath())).toBe(true);

    const deps = makeDeps();
    const result = await configureBeads('status', ctx, deps);

    expect(result.enabled).toBe(true);
    expect(result.running).toBe(true);
    const events = deps.emitted;
    expect(events[0]).toMatchObject({ type: 'beads_status', state: 'enabled', running: true });
  });

  // ── Phase 3: disable ──────────────────────────────────────────────────────

  it('disable — persists enabled:false on real config-store, emits disabled, returns enabled:false', async () => {
    const deps = makeDeps();
    const result = await configureBeads('disable', ctx, deps);

    // Verify the real config file was rewritten to disabled.
    const raw = fs.readFileSync(beadsConfigPath(), 'utf8');
    const cfg = JSON.parse(raw) as { enabled: boolean };
    expect(cfg.enabled).toBe(false);

    expect(result.enabled).toBe(false);

    // readEnabled() must reflect the new state immediately.
    expect(readBeadsEnabled()).toBe(false);

    const events = deps.emitted;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'beads_status', state: 'disabled' });
  });

  // ── Phase 4: status after disable ────────────────────────────────────────

  it('status — after disable → readEnabled()=false → short-circuits (probe NOT called) → running:false', async () => {
    // The key soft-disable invariant: dolt server stays up (no process kill),
    // so without the readEnabled guard a raw probe would falsely report enabled.
    const probeSpy = vi.fn().mockResolvedValue({
      bdAvailable: true, doltAvailable: true, serverUp: true, prefix: 'inttest_proj',
    });
    const deps = makeDeps({ probe: probeSpy });
    const result = await configureBeads('status', ctx, deps);

    // probe() must NOT be called (the persisted false flag short-circuits).
    expect(probeSpy).not.toHaveBeenCalled();
    expect(result.enabled).toBe(false);
    expect(result.running).toBe(false);

    const events = deps.emitted;
    expect(events[0]).toMatchObject({ type: 'beads_status', state: 'disabled', running: false });
  });

  // ── Phase 5: re-enable after disable ─────────────────────────────────────

  it('re-enable after disable — persists enabled:true again, probe NOT called (provision is)', async () => {
    const deps = makeDeps();
    const result = await configureBeads('enable', ctx, deps);

    const raw = fs.readFileSync(beadsConfigPath(), 'utf8');
    const cfg = JSON.parse(raw) as { enabled: boolean };
    expect(cfg.enabled).toBe(true);

    expect(result.enabled).toBe(true);
    expect(readBeadsEnabled()).toBe(true);
  });
});
