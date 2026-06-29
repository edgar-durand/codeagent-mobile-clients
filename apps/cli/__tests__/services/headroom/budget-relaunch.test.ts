/**
 * Unit tests for apps/cli/src/services/headroom/budget-relaunch.ts.
 *
 * Covers three exported functions:
 *   amendDeploymentManifestBudget — pure manifest transform
 *   findHeadroomDeployments       — fs-seam-based discovery
 *   applyBudgetToHeadroom         — orchestrator (SUPERVISED vs DIRECT)
 *
 * Regression guard: SUPERVISED branch must NOT call killProxy/spawnProxy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  amendDeploymentManifestBudget,
  findHeadroomDeployments,
  applyBudgetToHeadroom,
  type DeploymentManifest,
  type BudgetSpec,
  type ApplyBudgetDeps,
  type FindDeploymentDeps,
} from '../../../src/services/headroom/budget-relaunch';

// ── amendDeploymentManifestBudget ─────────────────────────────────────────────

describe('amendDeploymentManifestBudget', () => {
  const BASE: DeploymentManifest = {
    profile: 'init-user',
    port: 8787,
    proxy_args: ['--host', '127.0.0.1', '--port', '8787', '--mode', 'token'],
    base_env: { HEADROOM_PORT: '8787', HEADROOM_MODE: 'token' },
  };

  const BUDGET: BudgetSpec = { budgetUsd: 105, budgetPeriod: 'monthly' };

  it('adds budget args and env when budget non-null', () => {
    const result = amendDeploymentManifestBudget(BASE, BUDGET);
    expect(result.proxy_args).toEqual([
      '--host', '127.0.0.1', '--port', '8787', '--mode', 'token',
      '--budget', '105', '--budget-period', 'monthly',
    ]);
    expect(result.base_env?.['HEADROOM_BUDGET']).toBe('105');
    expect(result.base_env?.['HEADROOM_BUDGET_PERIOD']).toBe('monthly');
  });

  it('preserves other proxy_args and base_env entries', () => {
    const result = amendDeploymentManifestBudget(BASE, BUDGET);
    expect(result.proxy_args).toContain('--mode');
    expect(result.proxy_args).toContain('token');
    expect(result.base_env?.['HEADROOM_PORT']).toBe('8787');
    expect(result.base_env?.['HEADROOM_MODE']).toBe('token');
  });

  it('strips budget when budget=null', () => {
    const withBudget = amendDeploymentManifestBudget(BASE, BUDGET);
    const stripped = amendDeploymentManifestBudget(withBudget, null);
    expect(stripped.proxy_args).not.toContain('--budget');
    expect(stripped.proxy_args).not.toContain('--budget-period');
    expect(stripped.base_env?.['HEADROOM_BUDGET']).toBeUndefined();
    expect(stripped.base_env?.['HEADROOM_BUDGET_PERIOD']).toBeUndefined();
  });

  it('is idempotent — calling twice with same budget equals once', () => {
    const once = amendDeploymentManifestBudget(BASE, BUDGET);
    const twice = amendDeploymentManifestBudget(once, BUDGET);
    expect(twice.proxy_args).toEqual(once.proxy_args);
    expect(twice.base_env).toEqual(once.base_env);
  });

  it('does not mutate the input manifest', () => {
    const frozen = { ...BASE, proxy_args: [...(BASE.proxy_args ?? [])], base_env: { ...(BASE.base_env ?? {}) } };
    const origArgs = [...(frozen.proxy_args ?? [])];
    const origEnv = { ...(frozen.base_env ?? {}) };
    amendDeploymentManifestBudget(frozen, BUDGET);
    expect(frozen.proxy_args).toEqual(origArgs);
    expect(frozen.base_env).toEqual(origEnv);
  });

  it('handles manifest with no existing proxy_args or base_env', () => {
    const bare: DeploymentManifest = { profile: 'bare', port: 8787 };
    const result = amendDeploymentManifestBudget(bare, BUDGET);
    expect(result.proxy_args).toEqual(['--budget', '105', '--budget-period', 'monthly']);
    expect(result.base_env?.['HEADROOM_BUDGET']).toBe('105');
  });
});

// ── findHeadroomDeployments ───────────────────────────────────────────────────

describe('findHeadroomDeployments', () => {
  it('parses two profiles and returns their entries', () => {
    const manifests: Record<string, DeploymentManifest> = {
      'profile-a': { profile: 'profile-a', port: 8787, proxy_args: [], base_env: {} },
      'profile-b': { profile: 'profile-b', port: 9000, proxy_args: [], base_env: {} },
    };

    const deps: FindDeploymentDeps = {
      readDir: () => ['profile-a', 'profile-b'],
      readJson: (filePath: string) => {
        for (const [name, m] of Object.entries(manifests)) {
          if (filePath.includes(name)) return m;
        }
        throw new Error('not found');
      },
    };

    const result = findHeadroomDeployments('/home/user', deps);
    expect(result).toHaveLength(2);
    expect(result[0]?.profile).toBe('profile-a');
    expect(result[0]?.port).toBe(8787);
    expect(result[1]?.profile).toBe('profile-b');
    expect(result[1]?.port).toBe(9000);
  });

  it('returns [] when deploy directory is missing', () => {
    const deps: FindDeploymentDeps = {
      readDir: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      readJson: () => { throw new Error('should not be called'); },
    };
    const result = findHeadroomDeployments('/home/user', deps);
    expect(result).toEqual([]);
  });

  it('skips profiles with bad/unparseable JSON', () => {
    const deps: FindDeploymentDeps = {
      readDir: () => ['good', 'bad'],
      readJson: (filePath: string) => {
        if (filePath.includes('good')) return { profile: 'good', port: 8787, proxy_args: [], base_env: {} };
        throw new SyntaxError('Unexpected token');
      },
    };
    const result = findHeadroomDeployments('/home/user', deps);
    expect(result).toHaveLength(1);
    expect(result[0]?.profile).toBe('good');
  });

  it('skips profiles where manifest.json returns non-object', () => {
    const deps: FindDeploymentDeps = {
      readDir: () => ['null-manifest'],
      readJson: () => null,
    };
    const result = findHeadroomDeployments('/home/user', deps);
    expect(result).toEqual([]);
  });
});

// ── applyBudgetToHeadroom ─────────────────────────────────────────────────────

function makeDeps(overrides: Partial<ApplyBudgetDeps> = {}): {
  deps: ApplyBudgetDeps;
  mocks: {
    writeManifest: ReturnType<typeof vi.fn>;
    restartDeployment: ReturnType<typeof vi.fn>;
    killProxy: ReturnType<typeof vi.fn>;
    spawnProxy: ReturnType<typeof vi.fn>;
  };
} {
  const mocks = {
    writeManifest: vi.fn(),
    restartDeployment: vi.fn(),
    killProxy: vi.fn(),
    spawnProxy: vi.fn(),
  };
  const deps: ApplyBudgetDeps = {
    findDeployments: () => [],
    writeManifest: mocks.writeManifest,
    restartDeployment: mocks.restartDeployment,
    killProxy: mocks.killProxy,
    spawnProxy: mocks.spawnProxy,
    ...overrides,
  };
  return { deps, mocks };
}

const MANIFEST_A: DeploymentManifest = {
  profile: 'init-user',
  port: 8787,
  proxy_args: ['--host', '127.0.0.1', '--port', '8787', '--mode', 'token', '--backend', 'anthropic', '--telemetry'],
  base_env: { HEADROOM_PORT: '8787', HEADROOM_MODE: 'token' },
};

const BUDGET: BudgetSpec = { budgetUsd: 105, budgetPeriod: 'daily' };

describe('applyBudgetToHeadroom — SUPERVISED branch', () => {
  it('amends manifest and calls restartDeployment; does NOT call killProxy or spawnProxy', async () => {
    const { deps, mocks } = makeDeps({
      findDeployments: () => [
        { profile: 'init-user', manifestPath: '/home/.headroom/deploy/init-user/manifest.json', port: 8787, manifest: MANIFEST_A },
      ],
    });

    const result = await applyBudgetToHeadroom(BUDGET, deps);

    expect(result).toEqual({ path: 'supervised', profiles: ['init-user'] });

    // writeManifest called with amended manifest
    expect(mocks.writeManifest).toHaveBeenCalledOnce();
    const [writtenPath, writtenManifest] = mocks.writeManifest.mock.calls[0] as [string, DeploymentManifest];
    expect(writtenPath).toBe('/home/.headroom/deploy/init-user/manifest.json');
    expect(writtenManifest.proxy_args).toContain('--budget');
    expect(writtenManifest.proxy_args).toContain('105');
    expect(writtenManifest.proxy_args).toContain('--budget-period');
    expect(writtenManifest.proxy_args).toContain('daily');
    expect(writtenManifest.base_env?.['HEADROOM_BUDGET']).toBe('105');

    // restartDeployment called with profile
    expect(mocks.restartDeployment).toHaveBeenCalledWith('init-user');

    // REGRESSION GUARD: kill+respawn must NOT be called on supervised path
    expect(mocks.killProxy).not.toHaveBeenCalled();
    expect(mocks.spawnProxy).not.toHaveBeenCalled();
  });

  it('handles multiple supervised deployments on port 8787', async () => {
    const MANIFEST_B: DeploymentManifest = { ...MANIFEST_A, profile: 'second' };
    const { deps, mocks } = makeDeps({
      findDeployments: () => [
        { profile: 'first', manifestPath: '/tmp/first/manifest.json', port: 8787, manifest: MANIFEST_A },
        { profile: 'second', manifestPath: '/tmp/second/manifest.json', port: 8787, manifest: MANIFEST_B },
      ],
    });

    const result = await applyBudgetToHeadroom(BUDGET, deps);
    expect(result).toEqual({ path: 'supervised', profiles: ['first', 'second'] });
    expect(mocks.writeManifest).toHaveBeenCalledTimes(2);
    expect(mocks.restartDeployment).toHaveBeenCalledWith('first');
    expect(mocks.restartDeployment).toHaveBeenCalledWith('second');
    expect(mocks.killProxy).not.toHaveBeenCalled();
    expect(mocks.spawnProxy).not.toHaveBeenCalled();
  });

  it('ignores deployments on ports other than 8787', async () => {
    const { deps, mocks } = makeDeps({
      findDeployments: () => [
        { profile: 'other', manifestPath: '/tmp/other/manifest.json', port: 9000, manifest: { ...MANIFEST_A, port: 9000 } },
      ],
    });

    const result = await applyBudgetToHeadroom(BUDGET, deps);
    // No port-8787 deployments → falls through to direct
    expect(result).toEqual({ path: 'direct' });
    expect(mocks.writeManifest).not.toHaveBeenCalled();
    expect(mocks.killProxy).toHaveBeenCalled();
    expect(mocks.spawnProxy).toHaveBeenCalled();
  });

  it('passes budget=null to amendDeploymentManifestBudget (strip budget from manifest)', async () => {
    const withBudget: DeploymentManifest = {
      ...MANIFEST_A,
      proxy_args: [...(MANIFEST_A.proxy_args ?? []), '--budget', '50', '--budget-period', 'monthly'],
      base_env: { ...MANIFEST_A.base_env, HEADROOM_BUDGET: '50', HEADROOM_BUDGET_PERIOD: 'monthly' },
    };
    const { deps, mocks } = makeDeps({
      findDeployments: () => [
        { profile: 'init-user', manifestPath: '/tmp/manifest.json', port: 8787, manifest: withBudget },
      ],
    });

    await applyBudgetToHeadroom(null, deps);

    const [, writtenManifest] = mocks.writeManifest.mock.calls[0] as [string, DeploymentManifest];
    expect(writtenManifest.proxy_args).not.toContain('--budget');
    expect(writtenManifest.base_env?.['HEADROOM_BUDGET']).toBeUndefined();
  });
});

describe('applyBudgetToHeadroom — DIRECT branch', () => {
  it('calls killProxy and spawnProxy when no deployments', async () => {
    const { deps, mocks } = makeDeps({ findDeployments: () => [] });

    const result = await applyBudgetToHeadroom(BUDGET, deps);

    expect(result).toEqual({ path: 'direct' });
    expect(mocks.killProxy).toHaveBeenCalledOnce();
    expect(mocks.spawnProxy).toHaveBeenCalledWith(BUDGET);
    expect(mocks.writeManifest).not.toHaveBeenCalled();
    expect(mocks.restartDeployment).not.toHaveBeenCalled();
  });

  it('passes null budget through to spawnProxy when disabling', async () => {
    const { deps, mocks } = makeDeps({ findDeployments: () => [] });

    await applyBudgetToHeadroom(null, deps);

    expect(mocks.spawnProxy).toHaveBeenCalledWith(null);
    expect(mocks.killProxy).toHaveBeenCalled();
  });
});
