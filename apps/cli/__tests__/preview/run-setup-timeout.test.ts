import { describe, expect, it } from 'vitest';
import { runSetupCommand } from '../../src/services/preview/run-setup';

/**
 * BUG 1 (part a): the pre-flight `pnpm/npm install` step on a fresh
 * codespace (node_modules missing) is unbounded. If the install stalls
 * — a hung registry fetch, a lockfile prompt, a network black hole —
 * the dev server never spawns and the user waits on the spinner
 * forever. `runSetupCommand` time-bounds the step so a stall surfaces
 * as a `timeout` outcome the caller maps to a `preview_error`.
 */
describe('runSetupCommand', () => {
  const node = process.execPath;

  it('returns ok with exit code 0 for a fast successful command', async () => {
    const r = await runSetupCommand(node, ['-e', 'process.exit(0)'], process.cwd(), undefined, {
      timeoutMs: 5_000,
    });
    expect(r).toEqual({ status: 'ok', code: 0 });
  });

  it('returns failed with the non-zero exit code', async () => {
    const r = await runSetupCommand(node, ['-e', 'process.exit(3)'], process.cwd(), undefined, {
      timeoutMs: 5_000,
    });
    expect(r).toEqual({ status: 'failed', code: 3 });
  });

  it('returns timeout (and kills the child) when the command outruns the budget', async () => {
    // A process that sleeps far longer than the budget — simulates a
    // hung `pnpm install`.
    const r = await runSetupCommand(
      node,
      ['-e', 'setTimeout(() => {}, 60000)'],
      process.cwd(),
      undefined,
      { timeoutMs: 300 },
    );
    expect(r.status).toBe('timeout');
  });

  it('returns failed when the binary cannot be spawned', async () => {
    const r = await runSetupCommand(
      '/nonexistent/definitely-not-a-binary',
      ['install'],
      process.cwd(),
      undefined,
      { timeoutMs: 2_000 },
    );
    expect(r.status).toBe('failed');
  });
});
