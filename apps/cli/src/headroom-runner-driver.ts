/**
 * Headroom integration-test driver — invoked INSIDE a Docker container
 * by the real-Docker integration test (`headroom-provision.int.test.ts`).
 *
 * NOT part of the published CLI surface. Compiled by tsup as a second
 * entry point and shipped in `dist/` (covered by `"files": ["dist"]`).
 *
 * Exits 0 with JSON on stdout when all assertions pass; exits 1 with
 * `{ "error": "<message>" }` JSON when any assertion fails.
 *
 * Usage (inside container):
 *   node dist/headroom-runner-driver.js <action>
 *
 * Actions:
 *   enable   — run setupHeadroomForSelfHosted + probe :8787/stats + check settings.json
 *   disable  — run configureHeadroom('disable') + confirm proxy down + binary cached
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import {
  setupHeadroomForSelfHosted,
  restoreAgentHeadroomConfig,
  persistHeadroomConfig,
  headroomConfigPath,
  agentIdToHeadroomKind,
} from './commands/host-agent';
import { configureHeadroom, type ConfigureCtx, type ConfigureDeps } from './services/headroom/configure';
import { mapStatsToSavings, type StatsShape, type Savings } from './services/headroom/stats-reporter';

/** Structured result written to stdout. */
interface DriverResult {
  action: string;
  ok: boolean;
  checks: Record<string, boolean | string>;
  error?: string;
}

function report(result: DriverResult): never {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
}

async function probeStats(): Promise<Savings | null> {
  try {
    const res = await fetch('http://127.0.0.1:8787/stats');
    if (!res.ok) return null;
    const raw = (await res.json()) as StatsShape;
    return mapStatsToSavings(raw, {
      rawTokensEst: 0,
      sentTokensEst: 0,
      cachedTokens: 0,
      retrieveHops: 0,
      cacheReadTokens: 0,
      cacheSavingsUsd: 0,
      compressionTokens: 0,
      compressionSavingsUsd: 0,
      compressionPct: 0,
    }).next;
  } catch {
    return null;
  }
}

function headroomBinaryAvailable(): boolean {
  try {
    execFileSync('which', ['headroom'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function runEnable(): Promise<void> {
  const steps: string[] = [];
  const ok = await setupHeadroomForSelfHosted('claude', undefined, {
    extras: ['proxy', 'code', 'image'],
    onProgress: (step) => steps.push(step),
  });

  if (!ok) {
    report({
      action: 'enable',
      ok: false,
      checks: { setupReturned: false, steps: steps.join(',') },
      error: 'setupHeadroomForSelfHosted returned false',
    });
  }

  // Give the proxy a moment to bind (it's spawned detached).
  await new Promise((r) => setTimeout(r, 5000));

  // Probe :8787/stats.
  const stats = await probeStats();
  const proxyAnswers = stats !== null;

  // Check agent settings.json mentions 8787.
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let settingsMentions8787 = false;
  let settingsContent = '(not found)';
  try {
    settingsContent = fs.readFileSync(settingsPath, 'utf8');
    settingsMentions8787 = settingsContent.includes('8787');
  } catch {
    settingsMentions8787 = false;
  }

  const allOk = proxyAnswers && settingsMentions8787;
  report({
    action: 'enable',
    ok: allOk,
    checks: {
      setupReturnedTrue: true,
      proxyAnswers8787: proxyAnswers,
      settingsMentions8787,
      steps: steps.join(','),
      settingsSnippet: settingsContent.slice(0, 400),
    },
    ...(allOk ? {} : { error: 'one or more assertions failed' }),
  });
}

async function runDisable(): Promise<void> {
  const kind = agentIdToHeadroomKind('claude');

  const ctx: ConfigureCtx = { agent: 'claude' };
  const deps: ConfigureDeps = {
    setup: setupHeadroomForSelfHosted,
    probeStats,
    persist: persistHeadroomConfig,
    readEnabled: () => {
      try {
        const raw = JSON.parse(fs.readFileSync(headroomConfigPath(), 'utf8')) as { enabled?: boolean };
        return raw.enabled === true;
      } catch {
        return false;
      }
    },
    startReporter: () => { /* no-op: driver doesn't start a reporter */ },
    stopReporter: () => { /* no-op */ },
    restoreAgentHeadroomConfig: (k: string) => restoreAgentHeadroomConfig(k),
    stopProxy: () => {
      try {
        spawn('pkill', ['-TERM', '-f', 'headroom.*proxy'], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      } catch { /* best-effort */ }
    },
    emit: () => { /* no-op: no SSE channel in driver */ },
  };

  const result = await configureHeadroom('disable', ctx, deps);

  // Give the proxy a moment to die.
  await new Promise((r) => setTimeout(r, 3000));

  // Proxy must be down.
  const proxyStillAnswers = (await probeStats()) !== null;
  const proxyDown = !proxyStillAnswers;

  // Agent settings should be restored (backup should have been applied).
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let settingsMentions8787 = false;
  try {
    const content = fs.readFileSync(settingsPath, 'utf8');
    settingsMentions8787 = content.includes('8787');
  } catch {
    // If the file doesn't exist, the route is gone → ok (no 8787 means no proxy routing).
    settingsMentions8787 = false;
  }
  const configRestored = !settingsMentions8787;

  // Binary + model cache must remain (headroom binary still resolves).
  const binaryStillCached = headroomBinaryAvailable();

  const allOk = proxyDown && binaryStillCached;
  report({
    action: 'disable',
    ok: allOk,
    checks: {
      disableResult: JSON.stringify(result),
      proxyDown,
      configRestored,
      binaryStillCached,
      kind,
    },
    ...(allOk ? {} : { error: 'one or more disable assertions failed' }),
  });
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === 'enable') {
    await runEnable();
  } else if (action === 'disable') {
    await runDisable();
  } else {
    report({
      action: action ?? '(none)',
      ok: false,
      checks: {},
      error: `Unknown action "${action ?? ''}". Usage: node dist/headroom-runner-driver.js <enable|disable>`,
    });
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stdout.write(JSON.stringify({ action: 'unknown', ok: false, checks: {}, error: msg }) + '\n');
  process.exit(1);
});
