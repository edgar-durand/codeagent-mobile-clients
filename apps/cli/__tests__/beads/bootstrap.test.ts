import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bootstrapBeads } from '../../src/beads/bootstrap';
import type { BdRunResult } from '../../src/beads/bd-adapter';

/**
 * A scriptable fake adapter that records every `bd` invocation and answers
 * each subcommand from a programmable table, so the idempotency tests can
 * assert exactly which commands ran (and that a repeat run is a no-op).
 */
class FakeBd {
  calls: string[][] = [];
  available = true;
  /** keyed by the joined args prefix → exit code. */
  private codes: Record<string, number> = {};
  private json: Record<string, string> = {};

  isAvailable(): boolean {
    return this.available;
  }

  setCode(prefix: string, code: number): void {
    this.codes[prefix] = code;
  }
  setJson(prefix: string, stdout: string): void {
    this.json[prefix] = stdout;
  }

  async run(args: string[]): Promise<BdRunResult> {
    this.calls.push(args);
    const joined = args.join(' ');
    // Longest matching prefix wins so `setup claude --check` can differ from
    // `setup claude`.
    let bestPrefix = '';
    for (const prefix of Object.keys(this.codes)) {
      if (joined.startsWith(prefix) && prefix.length > bestPrefix.length) bestPrefix = prefix;
    }
    const code = bestPrefix ? this.codes[bestPrefix] : 0;
    const stdout = this.json[bestPrefix] ?? '';
    return { code, stdout, stderr: code === 0 ? '' : 'err' };
  }
}

describe('bootstrapBeads', () => {
  let fake: FakeBd;
  beforeEach(() => {
    fake = new FakeBd();
  });

  function ran(prefix: string): number {
    return fake.calls.filter((c) => c.join(' ').startsWith(prefix)).length;
  }

  it('skips entirely when bd is unavailable', async () => {
    fake.available = false;
    const res = await bootstrapBeads({ agents: ['claude'], adapter: fake as never });
    expect(res.bdAvailable).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it('cold start: starts the server, sets up the recipe, enables export', async () => {
    // dolt status fails first (server down), start succeeds, recheck passes.
    // Use a call-count toggle: first `dolt status` -> 1, after start -> 0.
    let doltStatusCalls = 0;
    const origRun = fake.run.bind(fake);
    fake.run = async (args) => {
      const joined = args.join(' ');
      if (joined.startsWith('dolt status')) {
        doltStatusCalls += 1;
        fake.calls.push(args);
        return { code: doltStatusCalls === 1 ? 1 : 0, stdout: '', stderr: '' };
      }
      return origRun(args);
    };
    // recipe not yet installed → --check fails → setup runs.
    fake.setCode('setup claude --check', 1);

    const res = await bootstrapBeads({ agents: ['claude'], adapter: fake as never });

    expect(res.serverUp).toBe(true);
    expect(res.agentsConfigured).toEqual(['claude']);
    expect(res.exportEnabled).toBe(true);
    expect(ran('dolt start')).toBe(1);
    expect(ran('setup claude --check')).toBe(1);
    expect(ran('setup claude')).toBe(2); // --check + the real setup
    expect(ran('config set export.jsonl')).toBe(1);
  });

  it('idempotent repeat: server already up + recipe already configured → no start, no re-setup', async () => {
    // dolt status passes (server up). setup --check passes (already configured).
    fake.setCode('dolt status', 0);
    fake.setCode('setup claude --check', 0);

    const res = await bootstrapBeads({ agents: ['claude'], adapter: fake as never });

    expect(res.serverUp).toBe(true);
    expect(res.agentsConfigured).toEqual([]); // nothing freshly applied
    expect(ran('dolt start')).toBe(0); // never started — already up
    expect(ran('setup claude --check')).toBe(1);
    // the bare `setup claude` (without --check) must NOT run on a repeat.
    expect(fake.calls.some((c) => c.join(' ') === 'setup claude')).toBe(false);
    expect(res.exportEnabled).toBe(true);
  });

  it('bails before wiring when the server fails to come up', async () => {
    fake.setCode('dolt status', 1); // always down, even after start
    fake.setCode('dolt start', 1); // start itself fails

    const res = await bootstrapBeads({ agents: ['claude'], adapter: fake as never });

    expect(res.serverUp).toBe(false);
    expect(res.agentsConfigured).toEqual([]);
    expect(ran('setup claude --check')).toBe(0); // never reached wiring
  });

  it('skips agents with no bd recipe but configures the ones that have one', async () => {
    fake.setCode('dolt status', 0);
    fake.setCode('setup claude --check', 1);
    fake.setCode('setup codex --check', 1);

    // coderabbit has no recipe mapping → should be skipped silently.
    const res = await bootstrapBeads({
      agents: ['claude', 'coderabbit', 'codex'],
      adapter: fake as never,
    });

    expect(res.agentsConfigured.sort()).toEqual(['claude', 'codex']);
    expect(fake.calls.some((c) => c.join(' ').startsWith('setup coderabbit'))).toBe(false);
  });
});
