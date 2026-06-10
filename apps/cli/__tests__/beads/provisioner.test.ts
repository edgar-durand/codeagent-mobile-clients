import path from 'node:path';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { provisionBeads, _provisionSeam, _linkSeam } from '../../src/beads/provisioner';
import type { BdRunResult } from '../../src/beads/bd-adapter';

/**
 * Scriptable fake adapter — records every `bd` invocation and answers each
 * subcommand from a programmable table so we can assert the EXACT verified
 * sequence ran (and that a repeat run skips init).
 */
class FakeBd {
  calls: string[][] = [];
  available = true;
  binary: string | null = '/pkg/@beads/bd/bin/bd';
  private codes: Record<string, number> = {};

  isAvailable(): boolean {
    return this.available;
  }
  resolveBinary(): string | null {
    return this.available ? this.binary : null;
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
    // Symlink the resolved bd onto PATH — mocked out so unit runs never touch
    // the real filesystem. Idempotency is covered in its own describe block.
    vi.spyOn(_provisionSeam, 'linkBdOntoPath').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('symlinks the resolved bd binary onto PATH (GAP 1) using the adapter binary', async () => {
    await provisionBeads({ adapter: fake as never, beadsDir: '/tmp/hb' });
    expect(_provisionSeam.linkBdOntoPath).toHaveBeenCalledTimes(1);
    expect(_provisionSeam.linkBdOntoPath).toHaveBeenCalledWith('/pkg/@beads/bd/bin/bd');
  });

  it('silences the bd role warning: `git config --global beads.role contributor`', async () => {
    const gitConfig = vi
      .spyOn(_provisionSeam, 'setGitBeadsRole')
      .mockImplementation(() => undefined);
    await provisionBeads({ adapter: fake as never, beadsDir: '/tmp/hb' });
    expect(gitConfig).toHaveBeenCalledTimes(1);
  });

  it('a thrown PATH symlink is strictly NON-FATAL (provisioning still completes)', async () => {
    (_provisionSeam.linkBdOntoPath as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('EACCES');
    });
    const res = await provisionBeads({ adapter: fake as never, beadsDir: '/tmp/hb' });
    expect(res.bdAvailable).toBe(true);
    expect(res.initialized).toBe(true);
    expect(res.exportEnabled).toBe(true);
  });

  it('cold start: inits the home brain (skip-agents/hooks, no --global) + enables export.auto', async () => {
    const res = await provisionBeads({ adapter: fake as never, beadsDir: '/tmp/hb' });

    expect(res.bdAvailable).toBe(true);
    expect(res.initialized).toBe(true);
    expect(res.exportEnabled).toBe(true);

    // The verified init invocation — the home brain init itself never uses
    // --global (that's the setup step, step 4).
    const init = fake.calls.find((c) => c[0] === 'init');
    expect(init).toBeDefined();
    expect(init).toContain('--skip-agents');
    expect(init).toContain('--skip-hooks');
    expect(init).toContain('--non-interactive');
    expect(init).not.toContain('--global');

    expect(ran(fake, 'config set export.auto true')).toBe(1);
  });

  it('runs `bd setup <recipe> --global` for each session agent — gated by --check (D12 — REVISED)', async () => {
    // --check returns non-zero → not yet installed → real setup must run.
    fake.setCode('setup claude --global --check', 1);
    fake.setCode('setup codex --global --check', 1);

    const res = await provisionBeads({
      adapter: fake as never,
      beadsDir: '/tmp/hb',
      agents: ['claude', 'codex'],
    });

    // Each agent: a --check probe, then the real --global setup.
    expect(ran(fake, 'setup claude --global --check')).toBe(1);
    expect(ran(fake, 'setup codex --global --check')).toBe(1);
    const claudeSetup = fake.calls.find((c) => c.join(' ') === 'setup claude --global');
    const codexSetup = fake.calls.find((c) => c.join(' ') === 'setup codex --global');
    expect(claudeSetup).toBeDefined();
    expect(codexSetup).toBeDefined();
    expect(res.agentsWired).toEqual(expect.arrayContaining(['claude', 'codex']));

    // Setup runs AFTER the home-brain init + export.auto (step ordering).
    const initIdx = fake.calls.findIndex((c) => c[0] === 'init');
    const setupIdx = fake.calls.findIndex((c) => c[0] === 'setup');
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(setupIdx).toBeGreaterThan(initIdx);
  });

  it('idempotent: when `--check` reports installed (exit 0), it does NOT re-run setup', async () => {
    // --check exit 0 → already wired → skip the real setup.
    fake.setCode('setup claude --global --check', 0);

    const res = await provisionBeads({
      adapter: fake as never,
      beadsDir: '/tmp/hb',
      agents: ['claude'],
    });

    expect(ran(fake, 'setup claude --global --check')).toBe(1);
    // No bare `setup claude --global` (without --check) was issued.
    expect(fake.calls.some((c) => c.join(' ') === 'setup claude --global')).toBe(false);
    // Still reported as wired (it's already installed).
    expect(res.agentsWired).toContain('claude');
  });

  it('skips agents bd ships no recipe for (coderabbit) — never calls setup for them', async () => {
    const res = await provisionBeads({
      adapter: fake as never,
      beadsDir: '/tmp/hb',
      agents: ['coderabbit'],
    });
    expect(fake.calls.some((c) => c[0] === 'setup')).toBe(false);
    expect(res.agentsWired).toEqual([]);
  });

  it('no agents (codespace infra path): the setup step is a no-op', async () => {
    const res = await provisionBeads({ adapter: fake as never, beadsDir: '/tmp/hb' });
    expect(fake.calls.some((c) => c[0] === 'setup')).toBe(false);
    expect(res.agentsWired).toEqual([]);
  });

  it('setup is strictly NON-FATAL: a failed/thrown setup never aborts provisioning', async () => {
    fake.setCode('setup claude --global --check', 1); // not installed
    fake.setCode('setup claude --global', 7); // setup itself fails

    const res = await provisionBeads({
      adapter: fake as never,
      beadsDir: '/tmp/hb',
      agents: ['claude'],
    });

    // Provisioning still completed — init + export are unaffected.
    expect(res.bdAvailable).toBe(true);
    expect(res.initialized).toBe(true);
    expect(res.exportEnabled).toBe(true);
    // The failed agent is simply absent from agentsWired (no throw bubbled up).
    expect(res.agentsWired).toEqual([]);
  });

  it('a thrown adapter.run during setup does not abort provisioning', async () => {
    fake.setCode('setup claude --global --check', 1);
    const realRun = fake.run.bind(fake);
    vi.spyOn(fake, 'run').mockImplementation(async (args: string[]) => {
      if (args.join(' ') === 'setup claude --global') throw new Error('boom');
      return realRun(args);
    });

    const res = await provisionBeads({
      adapter: fake as never,
      beadsDir: '/tmp/hb',
      agents: ['claude'],
    });

    expect(res.initialized).toBe(true);
    expect(res.exportEnabled).toBe(true);
    expect(res.agentsWired).toEqual([]);
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
    // bd never resolved → no PATH symlink attempt.
    expect(_provisionSeam.linkBdOntoPath).not.toHaveBeenCalled();
  });
});

describe('linkBdOntoPath — GAP 1 PATH symlink (idempotent)', () => {
  // linkBdOntoPath no-ops on win32 (codespaces are Linux); force a POSIX
  // platform so the symlink logic runs on Windows CI runners too. The
  // expected link path is built with path.join so the separator matches
  // the host (backslashes on Windows).
  const LINK = path.join('/usr/local/bin', 'bd');
  beforeEach(() => {
    vi.spyOn(_linkSeam, 'platform').mockReturnValue('linux');
    vi.spyOn(_linkSeam, 'ensureDir').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('creates a `bd` symlink to the resolved binary in the codeam bin dir', () => {
    const symlink = vi.fn();
    vi.spyOn(_linkSeam, 'cliBinDir').mockReturnValue('/usr/local/bin');
    vi.spyOn(_linkSeam, 'readlink').mockReturnValue(null); // nothing there yet
    vi.spyOn(_linkSeam, 'symlink').mockImplementation(symlink);
    vi.spyOn(_linkSeam, 'unlink').mockImplementation(() => undefined);

    _provisionSeam.linkBdOntoPath('/pkg/@beads/bd/bin/bd');

    expect(symlink).toHaveBeenCalledTimes(1);
    expect(symlink).toHaveBeenCalledWith('/pkg/@beads/bd/bin/bd', LINK);
  });

  it('is idempotent: skips when the symlink already points at the binary', () => {
    const symlink = vi.fn();
    vi.spyOn(_linkSeam, 'cliBinDir').mockReturnValue('/usr/local/bin');
    vi.spyOn(_linkSeam, 'readlink').mockReturnValue('/pkg/@beads/bd/bin/bd');
    vi.spyOn(_linkSeam, 'symlink').mockImplementation(symlink);

    _provisionSeam.linkBdOntoPath('/pkg/@beads/bd/bin/bd');

    expect(symlink).not.toHaveBeenCalled();
  });

  it('replaces a stale symlink that points elsewhere', () => {
    const symlink = vi.fn();
    const unlink = vi.fn();
    vi.spyOn(_linkSeam, 'cliBinDir').mockReturnValue('/usr/local/bin');
    vi.spyOn(_linkSeam, 'readlink').mockReturnValue('/old/bd');
    vi.spyOn(_linkSeam, 'symlink').mockImplementation(symlink);
    vi.spyOn(_linkSeam, 'unlink').mockImplementation(unlink);

    _provisionSeam.linkBdOntoPath('/pkg/@beads/bd/bin/bd');

    expect(unlink).toHaveBeenCalledWith(LINK);
    expect(symlink).toHaveBeenCalledWith('/pkg/@beads/bd/bin/bd', LINK);
  });

  it('no-ops on win32 (codespaces are Linux; nothing to symlink)', () => {
    const symlink = vi.fn();
    vi.spyOn(_linkSeam, 'platform').mockReturnValue('win32');
    vi.spyOn(_linkSeam, 'symlink').mockImplementation(symlink);
    _provisionSeam.linkBdOntoPath('C:/pkg/bd.exe');
    expect(symlink).not.toHaveBeenCalled();
  });

  it('no-ops when the CLI bin dir cannot be resolved', () => {
    const symlink = vi.fn();
    vi.spyOn(_linkSeam, 'cliBinDir').mockReturnValue(null);
    vi.spyOn(_linkSeam, 'symlink').mockImplementation(symlink);
    _provisionSeam.linkBdOntoPath('/pkg/@beads/bd/bin/bd');
    expect(symlink).not.toHaveBeenCalled();
  });
});

// cliBinDir is platform-agnostic and MUST return a correct NATIVE path on
// every OS the CLI ships to (mac / Linux / Windows) — only the symlink step
// (`linkBdOntoPath`) is a codespace-specific PATH workaround gated to
// non-Windows. So these expectations are built with `path.join`, which
// yields the right separators per platform: the contract under test is WHICH
// directory cliBinDir selects, and that must hold on the Windows shard too.
// (Asserting literal POSIX strings was a Windows false-failure that slipped
// in with the bd-on-PATH work.)
describe('_linkSeam.cliBinDir — picks an on-PATH, WRITABLE dir', () => {
  const origExecPath = process.execPath;
  const origArgv1 = process.argv[1];
  const origPath = process.env.PATH;

  afterEach(() => {
    process.execPath = origExecPath;
    process.argv[1] = origArgv1;
    process.env.PATH = origPath;
    vi.restoreAllMocks();
  });

  it('codespace: node lives in a /tmp prefix NOT on PATH → picks writable on-PATH ~/.local/bin', () => {
    // Native ~/.local/bin — backslashes on Windows, forward slashes
    // elsewhere — so the on-PATH match (and assertion) are exercised
    // with the same separators cliBinDir itself produces.
    const localBin = path.join('/home/codespace', '.local', 'bin');
    vi.spyOn(_linkSeam, 'homedir').mockReturnValue('/home/codespace');
    // Only ~/.local/bin is writable (node's /tmp prefix doesn't exist;
    // /usr/local/bin is read-only in codespaces).
    vi.spyOn(_linkSeam, 'isWritableDir').mockImplementation(
      (d: string) => d === localBin,
    );
    process.execPath = '/tmp/codeam-node20/bin/node';
    process.argv[1] = '/tmp/codeam-node20/lib/node_modules/codeam-cli/dist/cli.js';
    process.env.PATH = [localBin, '/usr/local/bin', '/usr/bin'].join(
      path.delimiter,
    );
    expect(_linkSeam.cliBinDir()).toBe(localBin);
  });

  it("global install: node's bin dir when it's on PATH AND writable", () => {
    vi.spyOn(_linkSeam, 'homedir').mockReturnValue('/home/u');
    vi.spyOn(_linkSeam, 'isWritableDir').mockReturnValue(true);
    process.execPath = '/home/u/.nvm/versions/node/v20/bin/node';
    process.argv[1] = '/home/u/.nvm/.../codeam-cli/dist/cli.js';
    process.env.PATH = ['/home/u/.nvm/versions/node/v20/bin', '/usr/bin'].join(path.delimiter);
    expect(_linkSeam.cliBinDir()).toBe('/home/u/.nvm/versions/node/v20/bin');
  });

  it('falls back to ~/.local/bin when nothing on PATH is writable', () => {
    vi.spyOn(_linkSeam, 'homedir').mockReturnValue('/home/u');
    vi.spyOn(_linkSeam, 'isWritableDir').mockReturnValue(false);
    process.execPath = '/opt/node/bin/node';
    process.argv[1] = '/pkg/codeam-cli/dist/cli.js';
    process.env.PATH = ['/usr/bin', '/bin'].join(path.delimiter);
    // The fallback is built with path.join → native separators per OS.
    expect(_linkSeam.cliBinDir()).toBe(path.join('/home/u', '.local', 'bin'));
  });
});
