import { describe, expect, it } from 'vitest';
import type { PreviewDetection } from '@codeagent/shared';
import { normalizeDetectionForSpawn } from '../../src/commands/start/handlers';

/**
 * The dev-server run command must not use pnpm/bun on the codespace runtime:
 * pnpm ≥10 needs Node ≥22.13 (imports node:sqlite) while codespaces ship
 * Node 20, and bun is often absent. The saved `.codeam/preview.json` for a
 * pnpm project carries `command:"pnpm", args:["dev"]` → BOOT_SEQUENCE
 * "pnpm dev" hung then failed ERR_SPAWN_FAILED (observed live). It must be
 * rewritten to `npm run dev`. yarn (yarn classic runs on Node 20) is left
 * alone. These assertions FAIL against the pre-fix normalizer (which only
 * rewrote npx) and pass now.
 */
function det(command: string, args: string[]): PreviewDetection {
  return {
    framework: 'Next.js',
    command,
    args,
    port: 3000,
    ready_pattern: 'Ready in|Local:',
    env: { HOST: '0.0.0.0' },
  } as unknown as PreviewDetection;
}

const CWD = '/workspaces/app';

describe('normalizeDetectionForSpawn — package-manager rewrite', () => {
  it('rewrites `pnpm dev` → `npm run dev` (the stuck-preview regression)', () => {
    const out = normalizeDetectionForSpawn(det('pnpm', ['dev']), CWD);
    expect(out.command).toBe('npm');
    expect(out.args).toEqual(['run', 'dev']);
  });

  it('rewrites `pnpm run dev` → `npm run dev`', () => {
    const out = normalizeDetectionForSpawn(det('pnpm', ['run', 'dev']), CWD);
    expect(out.command).toBe('npm');
    expect(out.args).toEqual(['run', 'dev']);
  });

  it('forwards extra flags after `--` (`pnpm dev -p 3000` → `npm run dev -- -p 3000`)', () => {
    const out = normalizeDetectionForSpawn(det('pnpm', ['dev', '-p', '3000']), CWD);
    expect(out.command).toBe('npm');
    expect(out.args).toEqual(['run', 'dev', '--', '-p', '3000']);
  });

  it('rewrites `bun dev` → `npm run dev` (bun often absent)', () => {
    const out = normalizeDetectionForSpawn(det('bun', ['dev']), CWD);
    expect(out.command).toBe('npm');
    expect(out.args).toEqual(['run', 'dev']);
  });

  it('leaves yarn alone (yarn classic runs on Node 20)', () => {
    const out = normalizeDetectionForSpawn(det('yarn', ['dev']), CWD);
    expect(out.command).toBe('yarn');
    expect(out.args).toEqual(['dev']);
  });

  it('leaves npm alone', () => {
    const out = normalizeDetectionForSpawn(det('npm', ['run', 'dev']), CWD);
    expect(out.command).toBe('npm');
    expect(out.args).toEqual(['run', 'dev']);
  });

  it('does not rewrite `pnpm exec <bin>` (one-off binary fetch)', () => {
    const out = normalizeDetectionForSpawn(det('pnpm', ['exec', 'serve']), CWD);
    expect(out.command).toBe('pnpm');
    expect(out.args).toEqual(['exec', 'serve']);
  });
});
