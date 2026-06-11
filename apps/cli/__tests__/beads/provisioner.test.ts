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
    vi.spyOn(_provisionSeam, 'install').mockResolvedValue({ ok: true, code: 0, stderr: '' });
    // Default happy path: dolt is on PATH, the shared server is already up, and
    // the project resolves to a fixed key (→ a deterministic prefix).
    vi.spyOn(_provisionSeam, 'doltOnPath').mockReturnValue(true);
    vi.spyOn(_provisionSeam, 'installDolt').mockResolvedValue({ ok: true, code: 0, stderr: '' });
    vi.spyOn(_provisionSeam, 'installDoltToDir').mockResolvedValue({ ok: true, code: 0, stderr: '' });
    vi.spyOn(_linkSeam, 'cliBinDir').mockReturnValue('/home/u/.local/bin');
    vi.spyOn(_linkSeam, 'ensureDir').mockImplementation(() => undefined);
    vi.spyOn(_provisionSeam, 'ensureSharedServer').mockResolvedValue({ up: true, started: false });
    vi.spyOn(_provisionSeam, 'sleep').mockResolvedValue(undefined); // instant backoff in tests
    vi.spyOn(_provisionSeam, 'deriveProjectIdentity').mockReturnValue({
      projectKey: 'github.com/edgar-durand/codeagent-mobile',
      projectLabel: 'codeagent-mobile',
    });
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

  it('cold start: inits the per-project prefix DB (-p, --shared-server, no --global) + export.auto', async () => {
    const res = await provisionBeads({ adapter: fake as never, beadsDir: '/tmp/hb' });

    expect(res.bdAvailable).toBe(true);
    expect(res.doltAvailable).toBe(true);
    expect(res.serverUp).toBe(true);
    expect(res.initialized).toBe(true);
    expect(res.exportEnabled).toBe(true);
    // Prefix derived from the (mocked) projectKey — stable + bd-safe.
    expect(res.prefix).toMatch(/^codeagent_mobile_[0-9a-f]{8}$/);

    // The init invocation: D17 — ALWAYS our explicit `-p <prefix>` so we never
    // inherit a foreign dolt_database; shared-server; never --global.
    const init = fake.calls.find((c) => c[0] === 'init');
    expect(init).toBeDefined();
    expect(init).toContain('-p');
    expect(init).toContain(res.prefix);
    expect(init).toContain('--shared-server');
    expect(init).toContain('--skip-agents');
    expect(init).toContain('--skip-hooks');
    expect(init).toContain('--non-interactive');
    expect(init).not.toContain('--global');

    expect(ran(fake, 'config set export.auto true')).toBe(1);
  });

  it('dolt missing → runs the per-OS dolt installer, then proceeds', async () => {
    let installed = false;
    (_provisionSeam.doltOnPath as ReturnType<typeof vi.fn>).mockImplementation(() => installed);
    const di = vi.spyOn(_provisionSeam, 'installDolt').mockImplementation(async () => {
      installed = true; // installer made dolt resolvable
      return { ok: true, code: 0, stderr: '' };
    });
    const res = await provisionBeads({ adapter: fake as never, beadsDir: '/tmp/hb' });
    expect(di).toHaveBeenCalledTimes(1);
    expect(res.doltAvailable).toBe(true);
    expect(res.initialized).toBe(true);
  });

  it('no sudo: official install does not resolve → tarball fallback into ~/.local/bin succeeds', async () => {
    // dolt never on PATH until the tarball fallback "installs" it.
    let resolved = false;
    (_provisionSeam.doltOnPath as ReturnType<typeof vi.fn>).mockImplementation(() => resolved);
    vi.spyOn(_provisionSeam, 'installDolt').mockResolvedValue({ ok: false, code: 1, stderr: 'E_UID_NONZERO' });
    const toDir = vi.spyOn(_provisionSeam, 'installDoltToDir').mockImplementation(async () => {
      resolved = true; // extracted dolt into the user dir → now resolvable
      return { ok: true, code: 0, stderr: '' };
    });
    const res = await provisionBeads({ adapter: fake as never, beadsDir: '/tmp/hb' });
    expect(toDir).toHaveBeenCalledWith('/home/u/.local/bin');
    expect(res.doltAvailable).toBe(true);
    expect(res.initialized).toBe(true);
  });

  it('dolt missing AND both official + tarball fallback fail → doltAvailable:false, no init', async () => {
    (_provisionSeam.doltOnPath as ReturnType<typeof vi.fn>).mockReturnValue(false);
    vi.spyOn(_provisionSeam, 'installDolt').mockResolvedValue({ ok: false, code: 1, stderr: 'no sudo' });
    const toDir = vi
      .spyOn(_provisionSeam, 'installDoltToDir')
      .mockResolvedValue({ ok: false, code: 1, stderr: 'no net' });
    const res = await provisionBeads({ adapter: fake as never, beadsDir: '/tmp/hb' });
    expect(toDir).toHaveBeenCalled(); // fallback was attempted before giving up
    expect(res.bdAvailable).toBe(true);
    expect(res.doltAvailable).toBe(false);
    expect(res.initialized).toBe(false);
    expect(fake.calls.some((c) => c[0] === 'init')).toBe(false);
  });

  it('inits the workspace BEFORE starting the server (codespace ordering fix)', async () => {
    // bd dolt start fails "no active beads workspace found" if no workspace
    // exists yet — so init MUST precede ensureSharedServer (the v2.36.0 bug).
    let initBeforeServer = false;
    vi.spyOn(_provisionSeam, 'ensureSharedServer').mockImplementation(async () => {
      initBeforeServer = fake.calls.some((c) => c[0] === 'init');
      return { up: true, started: true };
    });
    await provisionBeads({ adapter: fake as never, beadsDir: '/tmp/hb' });
    expect(initBeforeServer).toBe(true);
  });

  it('shared server cannot start → init ran first, serverUp:false, bail before export/agents', async () => {
    vi.spyOn(_provisionSeam, 'ensureSharedServer').mockResolvedValue({ up: false, started: false });
    const res = await provisionBeads({
      adapter: fake as never,
      beadsDir: '/tmp/hb',
      agents: ['claude'],
    });
    expect(res.doltAvailable).toBe(true);
    expect(res.initialized).toBe(true); // init runs BEFORE server start (the fix)
    expect(res.serverUp).toBe(false);
    expect(res.exportEnabled).toBe(false); // bailed before export
    expect(res.agentsWired).toEqual([]); // bailed before agent wiring
    expect(fake.calls.some((c) => c[0] === 'init')).toBe(true);
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

  it('retries bd setup on a transient spawn failure (code -1 / ENOENT) then succeeds', async () => {
    // First `setup claude --global` (no --check) spawn-fails (-1, the postinstall
    // rename window); the retry succeeds → claude ends up wired.
    fake.setCode('setup claude --global --check', 1); // not yet installed
    let setupCalls = 0;
    const realRun = fake.run.bind(fake);
    vi.spyOn(fake, 'run').mockImplementation(async (args: string[]) => {
      if (args.join(' ') === 'setup claude --global') {
        setupCalls += 1;
        return setupCalls === 1
          ? { code: -1, stdout: '', stderr: 'spawn .../@beads/bd/bin/bd ENOENT' }
          : { code: 0, stdout: '', stderr: '' };
      }
      return realRun(args);
    });

    const res = await provisionBeads({
      adapter: fake as never,
      beadsDir: '/tmp/hb',
      agents: ['claude'],
    });

    expect(setupCalls).toBe(2); // failed once, retried once
    expect(res.agentsWired).toContain('claude');
  });

  it('does NOT retry bd setup on a genuine non-(-1) failure', async () => {
    fake.setCode('setup claude --global --check', 1);
    fake.setCode('setup claude --global', 7); // real error, not a spawn glitch
    const res = await provisionBeads({
      adapter: fake as never,
      beadsDir: '/tmp/hb',
      agents: ['claude'],
    });
    // Exactly ONE real setup attempt (the bare `setup claude --global`, not --check) — no retry.
    expect(fake.calls.filter((c) => c.join(' ') === 'setup claude --global')).toHaveLength(1);
    expect(res.agentsWired).toEqual([]);
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

  it('idempotent: an already-initialized prefix DB ("already initialized") is treated as success', async () => {
    // bd init aborts with a non-zero code + "already initialized" notice when
    // the prefix DB already exists on the shared server — that's success, not
    // failure, so provisioning continues to export.auto + setup.
    fake.run = async (args: string[]): Promise<BdRunResult> => {
      fake.calls.push(args);
      if (args[0] === 'init') {
        return { code: 1, stdout: '', stderr: 'This workspace is already initialized.' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const res = await provisionBeads({ adapter: fake as never, beadsDir: '/tmp/hb' });

    expect(res.initialized).toBe(true); // already-init notice → treated as success
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
