// src/services/headroom/budget-relaunch.ts
/**
 * Routes a Headroom budget change to the right relaunch path:
 *
 *   1. SUPERVISED — `headroom install` owns the proxy (manifest at
 *      ~/.headroom/deploy/<profile>/manifest.json, port===8787).
 *      → Amend manifest proxy_args + base_env, then
 *        `headroom install restart --profile <profile>`.
 *        Do NOT kill/respawn directly (supervisor wins the port race).
 *
 *   2. DIRECT — codespace (setsid nohup) or self-hosted (setupHeadroomForSelfHosted).
 *      No manifests → kill existing proxy + respawn with --budget args.
 *
 * All three surfaces produce the same observable: proxy running with the new
 * --budget / no-budget configuration and /stats budget_limit_usd reflecting it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { log } from '../logger';
import { killHeadroomProxy } from './proxy-pid';
import { spawnHeadroomProxy } from './proxy-process';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BudgetSpec {
  budgetUsd: number;
  budgetPeriod: 'hourly' | 'daily' | 'monthly';
}

/** Raw structure of ~/.headroom/deploy/<profile>/manifest.json. */
export interface DeploymentManifest {
  profile?: string;
  port?: number;
  proxy_args?: string[];
  base_env?: Record<string, string>;
  [key: string]: unknown;
}

export interface DeploymentEntry {
  profile: string;
  manifestPath: string;
  port: number;
  manifest: DeploymentManifest;
}

export interface FindDeploymentDeps {
  readDir: (dir: string) => string[];
  readJson: (filePath: string) => unknown;
}

export interface ApplyBudgetDeps {
  findDeployments: () => DeploymentEntry[];
  writeManifest: (manifestPath: string, manifest: DeploymentManifest) => void;
  restartDeployment: (profile: string) => void;
  killProxy: () => void;
  spawnProxy: (budget: BudgetSpec | null) => void;
}

export type ApplyBudgetResult =
  | { path: 'supervised'; profiles: string[] }
  | { path: 'direct' };

// ── Pure: manifest amendment ──────────────────────────────────────────────────

/**
 * Returns a NEW manifest with budget args/env set (or stripped when budget=null).
 * Does not mutate the input.
 */
export function amendDeploymentManifestBudget(
  manifest: DeploymentManifest,
  budget: BudgetSpec | null,
): DeploymentManifest {
  // Strip existing budget flags from proxy_args (--budget <v> and --budget-period <v>).
  const rawArgs = manifest.proxy_args ?? [];
  const strippedArgs: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--budget' || rawArgs[i] === '--budget-period') {
      i++; // skip the value token too
      continue;
    }
    strippedArgs.push(rawArgs[i]!);
  }

  // Strip budget keys from base_env.
  const rawEnv = manifest.base_env ?? {};
  const strippedEnv = { ...rawEnv };
  delete strippedEnv['HEADROOM_BUDGET'];
  delete strippedEnv['HEADROOM_BUDGET_PERIOD'];

  if (!budget) {
    return { ...manifest, proxy_args: strippedArgs, base_env: strippedEnv };
  }

  const newArgs = [
    ...strippedArgs,
    '--budget',
    String(budget.budgetUsd),
    '--budget-period',
    budget.budgetPeriod,
  ];
  const newEnv = {
    ...strippedEnv,
    HEADROOM_BUDGET: String(budget.budgetUsd),
    HEADROOM_BUDGET_PERIOD: budget.budgetPeriod,
  };

  return { ...manifest, proxy_args: newArgs, base_env: newEnv };
}

// ── Discovery ─────────────────────────────────────────────────────────────────

/**
 * Reads ~/.headroom/deploy/<profile>/manifest.json for each profile subdirectory.
 * Missing deploy dir → []. Bad JSON for a profile → that entry is skipped.
 */
export function findHeadroomDeployments(
  homeDir: string,
  deps: FindDeploymentDeps,
): DeploymentEntry[] {
  const deployDir = path.join(homeDir, '.headroom', 'deploy');
  let profiles: string[];
  try {
    profiles = deps.readDir(deployDir);
  } catch {
    return [];
  }

  const results: DeploymentEntry[] = [];
  for (const profile of profiles) {
    const manifestPath = path.join(deployDir, profile, 'manifest.json');
    let raw: unknown;
    try {
      raw = deps.readJson(manifestPath);
    } catch {
      continue; // bad JSON or missing file — skip
    }
    if (!raw || typeof raw !== 'object') continue;
    const manifest = raw as DeploymentManifest;
    const port = typeof manifest.port === 'number' ? manifest.port : 0;
    results.push({ profile, manifestPath, port, manifest });
  }
  return results;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Routes the budget change to supervised or direct path.
 *
 * SUPERVISED (port===8787 manifest found):
 *   - Amend each manifest + `headroom install restart --profile <profile>`.
 *   - killProxy / spawnProxy are NOT called.
 *
 * DIRECT (no supervised deployment):
 *   - killProxy() then spawnProxy(budget).
 */
export async function applyBudgetToHeadroom(
  budget: BudgetSpec | null,
  deps: ApplyBudgetDeps,
): Promise<ApplyBudgetResult> {
  const supervised = deps.findDeployments().filter((d) => d.port === 8787);

  if (supervised.length > 0) {
    log.info('headroom-budget', `supervised path — amending ${supervised.length} deployment(s)`);
    for (const d of supervised) {
      const amended = amendDeploymentManifestBudget(d.manifest, budget);
      deps.writeManifest(d.manifestPath, amended);
      deps.restartDeployment(d.profile);
    }
    return { path: 'supervised', profiles: supervised.map((d) => d.profile) };
  }

  log.info('headroom-budget', 'direct path — kill + respawn proxy');
  deps.killProxy();
  deps.spawnProxy(budget);
  return { path: 'direct' };
}

// ── Real deps implementation ──────────────────────────────────────────────────

/** Atomic JSON write: tmp file + rename. Preserves 2-space formatting. */
function writeManifestReal(manifestPath: string, manifest: DeploymentManifest): void {
  const tmp = manifestPath + '.codeam.tmp';
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, manifestPath);
}

function restartDeploymentReal(profile: string): void {
  try {
    const proc = spawn('headroom', ['install', 'restart', '--profile', profile], {
      detached: true,
      stdio: 'ignore',
    });
    proc.once('error', (e: Error) => {
      log.warn('headroom-budget', `restart deployment '${profile}' error (best-effort): ${e.message}`);
    });
    proc.unref();
  } catch (e) {
    log.warn(
      'headroom-budget',
      `restart deployment '${profile}' failed (best-effort): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function killProxyReal(): void {
  // Targeted pid kill via the pidfile; falls back to the legacy pkill pattern
  // only when no live recorded pid exists. Best-effort — never throws.
  killHeadroomProxy();
}

function spawnProxyReal(_budget: BudgetSpec | null): void {
  // budget env vars have already been set/cleared on process.env by the handler
  // before calling applyBudgetToHeadroom — buildBudgetProxyArgs (inside the
  // shared spawnHeadroomProxy) reads them.
  spawnHeadroomProxy(
    {
      tag: 'headroom-budget',
      spawnErrorMsg: (detail) => `proxy relaunch error (best-effort): ${detail}`,
      failureMsg: (detail) => `proxy relaunch failed (best-effort): ${detail}`,
    },
    // Deliberate relaunch (killProxyReal already ran) — must never be swallowed
    // by a lock a liveness supervisor happens to hold.
    { force: true },
  );
}

/** Real deps wired to actual fs + child_process. */
export function makeRealApplyBudgetDeps(): ApplyBudgetDeps {
  const homeDir = os.homedir();
  return {
    findDeployments: () =>
      findHeadroomDeployments(homeDir, {
        readDir: (dir) => fs.readdirSync(dir),
        readJson: (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown,
      }),
    writeManifest: writeManifestReal,
    restartDeployment: restartDeploymentReal,
    killProxy: killProxyReal,
    spawnProxy: spawnProxyReal,
  };
}
