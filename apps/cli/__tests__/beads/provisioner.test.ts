import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { provisionBeads, _provisionSeam } from '../../src/beads/provisioner';
import type { BdRunResult } from '../../src/beads/bd-adapter';

/**
 * Scriptable fake adapter — records every `bd` invocation and answers each
 * subcommand from a programmable table so we can assert the EXACT verified
 * sequence ran (and that a repeat run skips init).
 */
class FakeBd {
  calls: string[][] = [];
  available = true;
  private codes: Record<string, number> = {};

  isAvailable(): boolean {
    return this.available;
  }
  setCode(prefix: string, code: number): void {
    this.codes[prefix] = code;
  }
  async run(args: string[]): Promise<BdRunResult> {
    this.calls.push(args);
    const joined = args.join(' ');
    let best = '';
    for (const p of Object.keys(this.codes)) {
      if (joined.startsWith(p) && p.length > best.length) best = p;
    }
    const code = best ? this.codes[best] : 0;
    return { code, stdout: '', stderr: code === 0 ? '' : 'err' };
  }
}

function ran(fake: FakeBd, prefix: string): number {
  return fake.calls.filter((c) => c.join(' ').startsWith(prefix)).length;
}

describe('provisionBeads', () => {
  let fake: FakeBd;
  beforeEach(() => {
    fake = new FakeBd();
    // Default: the home brain is NOT yet initialized (no embeddeddolt dir).
    vi.spyOn(_provisionSeam, 'homeBrainInitialized').mockReturnValue(false);
    vi.spyOn(_provisionSeam, 'install').mockResolvedValue({ ok: true, code: 0, stderr: '' });
  });
  afterEach(() => vi.restoreAllMocks());

  it('cold start: inits the home brain (skip-agents/hooks, no --global) + enables export.auto', async () => {
    const res = await provisionBeads({ adapter: fake as never, beadsDir: '/tmp/hb' });

    expect(res.bdAvailable).toBe(true);
    expect(res.initialized).toBe(true);
    expect(res.exportEnabled).toBe(true);

    // The verified init invocation — never with --global, never bd setup.
    const init = fake.calls.find((c) => c[0] === 'init');
    expect(init).toBeDefined();
    expect(init).toContain('--skip-agents');
    expect(init).toContain('--skip-hooks');
    expect(init).toContain('--non-interactive');
    expect(init).not.toContain('--global');

    expect(ran(fake, 'config set export.auto true')).toBe(1);
  });

  it('NEVER runs `bd setup <recipe>` (P0 must not mutate workspace CLAUDE.md/AGENTS.md)', async () => {
    await provisionBeads({ adapter: fake as never, beadsDir: '/tmp/hb' });
    expect(fake.calls.some((c) => c[0] === 'setup')).toBe(false);
  });

  it('idempotent: when the home brain already exists, it does NOT re-init', async () => {
    vi.spyOn(_provisionSeam, 'homeBrainInitialized').mockReturnValue(true);
    const res = await provisionBeads({ adapter: fake as never, beadsDir: '/tmp/hb' });

    expect(res.initialized).toBe(true); // already there
    expect(fake.calls.some((c) => c[0] === 'init')).toBe(false); // never re-init
    // export.auto is still (idempotently) asserted.
    expect(ran(fake, 'config set export.auto true')).toBe(1);
  });

  it('runs the install-bd fallback when the binary is missing (does NOT just skip)', async () => {
    fake.available = false;
    const install = vi
      .spyOn(_provisionSeam, 'install')
      .mockImplementation(async () => {
        fake.available = true; // installer made bd resolvable
        return { ok: true, code: 0, stderr: '' };
      });

    const res = await provisionBeads({ adapter: fake as never, beadsDir: '/tmp/hb' });

    expect(install).toHaveBeenCalledTimes(1);
    expect(res.bdAvailable).toBe(true);
    expect(res.initialized).toBe(true);
  });

  it('returns bdAvailable:false (no throw) when bd is missing AND install fails', async () => {
    fake.available = false;
    vi.spyOn(_provisionSeam, 'install').mockResolvedValue({ ok: false, code: 1, stderr: 'no net' });

    const res = await provisionBeads({ adapter: fake as never, beadsDir: '/tmp/hb' });

    expect(res.bdAvailable).toBe(false);
    expect(res.initialized).toBe(false);
    // No bd commands attempted once we know the binary can't be resolved.
    expect(fake.calls).toHaveLength(0);
  });
});
