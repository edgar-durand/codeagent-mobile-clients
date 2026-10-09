/**
 * Beads provisioning over a REAL process boundary (codeagent-fyas item 5).
 *
 * `provisionBeads` runs for real against a fake `bd` (a POSIX sh script that
 * logs every invocation's argv/env/cwd and keeps a tiny state machine on disk)
 * and a fake `dolt` on PATH. The real `BdAdapter` spawns it, the real
 * `ensureSharedServer` drives `bd dolt status/start`, the real
 * `deriveProjectIdentity` reads a real git origin, and the real
 * `linkBdOntoPath` writes the symlink. Only three boundaries are stubbed: where
 * the bundled binary lives, the global git config write, and the poll sleep.
 *
 * Invariants, each one a past incident:
 *   · `BEADS_DOLT_SHARED_SERVER=1` on EVERY bd call (else bd dies "dolt is not
 *     installed" — the server-mode build, D15).
 *   · `BEADS_DIR` is never passed, even when inherited (v2.36.0/1 "no active
 *     beads workspace found").
 *   · `bd init` runs BEFORE `bd dolt start` (the fake refuses to start a
 *     server with no workspace, like the real bd — the v2.36.0 ordering bug).
 *   · `bd` is symlinked onto `~/.local/bin` so the AGENT's shell resolves it
 *     (v2.39.5 `bd: command not found`).
 *   · `bd setup claude --global` runs OUTSIDE the project (it would add a
 *     77-line block to the user's CLAUDE.md).
 *   · the spawn race: a transient ENOENT / ETXTBSY on the binary is retried
 *     (v2.36.5 / v2.39.4), and HOME is backfilled for a detached host-agent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { provisionBeads, _provisionSeam } from '../../src/beads/provisioner';
import { BdAdapter, _resolveSeam, _adapterSeam } from '../../src/beads/bd-adapter';
import { _daemonSeam } from '../../src/beads/dolt-daemon';

const FAKE_BD = `#!/bin/sh
printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$*" "\${BEADS_DOLT_SHARED_SERVER-<unset>}" "\${BEADS_DIR-<unset>}" "\${HOME-<unset>}" "$(pwd -P)" >> "$FAKE_BD_LOG"
state="$FAKE_BD_STATE"
case "$1 $2" in
  "dolt status")
    if [ -f "$state/server" ]; then echo "Dolt server: running"; else echo "Dolt server: not running"; fi
    exit 0;;
  "dolt start")
    if [ -f "$state/workspace" ]; then : > "$state/server"; exit 0; fi
    echo "Error: no active beads workspace found" >&2; exit 1;;
esac
case "$1" in
  init) : > "$state/workspace"; exit 0;;
  ping) [ -f "$state/server" ] && exit 0; exit 1;;
  setup) case "$*" in *--check*) exit 1;; esac; exit 0;;
esac
exit 0
`;

interface BdCall {
  args: string;
  sharedServer: string;
  beadsDir: string;
  home: string;
  cwd: string;
}

function readCalls(logFile: string): BdCall[] {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [args, sharedServer, beadsDir, home, cwd] = line.split('\t');
      return { args, sharedServer, beadsDir, home, cwd };
    });
}

function writeExecutable(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

const ENV_KEYS = ['PATH', 'HOME', 'BEADS_DIR', 'FAKE_BD_LOG', 'FAKE_BD_STATE'] as const;

describe.skipIf(process.platform === 'win32')('beads provisioning — real bd process boundary', () => {
  let root: string;
  let home: string;
  let localBin: string;
  let project: string;
  let fakeBd: string;
  let logFile: string;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  const savedSeams = {
    resolveBundled: _resolveSeam.resolveBundled,
    setGitBeadsRole: _provisionSeam.setGitBeadsRole,
    daemonSleep: _daemonSeam.sleep,
    adapterSleep: _adapterSeam.sleep,
  };

  beforeAll(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'beads-prov-int-')));
    home = path.join(root, 'home');
    localBin = path.join(home, '.local', 'bin');
    project = path.join(root, 'widget');
    // The bundled @beads/bd lives in a transient prefix that is NOT on the
    // agent's PATH (the codespace `/tmp/codeam-node20` situation).
    fakeBd = path.join(root, 'bundled', 'bin', 'bd');
    logFile = path.join(root, 'bd-calls.log');
    writeExecutable(fakeBd, FAKE_BD);
    writeExecutable(path.join(localBin, 'dolt'), '#!/bin/sh\nexit 0\n');
    fs.mkdirSync(path.join(root, 'state'), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: project });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widget.git'], {
      cwd: project,
    });

    process.env.HOME = home;
    process.env.PATH = `${localBin}${path.delimiter}${savedEnv.PATH ?? ''}`;
    process.env.BEADS_DIR = '/stale/inherited/brain';
    process.env.FAKE_BD_LOG = logFile;
    process.env.FAKE_BD_STATE = path.join(root, 'state');

    _resolveSeam.resolveBundled = () => fakeBd;
    // Never write the real global git config from a test.
    _provisionSeam.setGitBeadsRole = () => undefined;
    _daemonSeam.sleep = async () => undefined;
  });

  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    _resolveSeam.resolveBundled = savedSeams.resolveBundled;
    _provisionSeam.setGitBeadsRole = savedSeams.setGitBeadsRole;
    _daemonSeam.sleep = savedSeams.daemonSleep;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('provisions end to end with every env / ordering / PATH invariant held', async () => {
    const result = await provisionBeads({ cwd: project, agents: ['claude'] });

    expect(result).toMatchObject({
      bdAvailable: true,
      doltAvailable: true,
      serverUp: true,
      initialized: true,
      exportEnabled: true,
      agentsWired: ['claude'],
    });
    // The prefix (= the shared-server DB name) comes from the real git origin.
    expect(result.prefix).toMatch(/^widget_[0-9a-f]{8}$/);

    const calls = readCalls(logFile);
    expect(calls.length).toBeGreaterThan(5);
    for (const c of calls) {
      expect(c.sharedServer, `bd ${c.args}`).toBe('1');
      expect(c.beadsDir, `bd ${c.args}`).toBe('<unset>');
      expect(c.home, `bd ${c.args}`).toBe(home);
    }

    const init = calls.findIndex((c) => c.args.startsWith('init '));
    const start = calls.findIndex((c) => c.args === 'dolt start');
    expect(init).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(init);
    expect(calls[init].args).toContain(`-p ${result.prefix} --shared-server`);
    expect(calls[init].args).toContain('--stealth');
    expect(calls[init].cwd).toBe(project);
    expect(calls.some((c) => c.args === 'config set export.auto true')).toBe(true);

    const setups = calls.filter((c) => c.args.startsWith('setup claude --global'));
    expect(setups.map((c) => c.args)).toEqual([
      'setup claude --global --check',
      'setup claude --global',
    ]);
    for (const s of setups) expect(s.cwd).not.toBe(project);

    // `bd` is on the agent's PATH via ~/.local/bin, pointing at the bundled binary.
    const link = path.join(localBin, 'bd');
    expect(fs.readlinkSync(link)).toBe(fakeBd);
    const resolved = spawnSync('sh', ['-c', 'command -v bd'], {
      env: { PATH: `${localBin}${path.delimiter}/usr/bin${path.delimiter}/bin` },
      encoding: 'utf8',
    });
    expect(resolved.stdout.trim()).toBe(link);

    // Beads files stay out of the user's git status (local exclude, no commit).
    const exclude = fs.readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.beads/');
  });

  it('a second run is idempotent: reuses the server and keeps the symlink', async () => {
    fs.rmSync(logFile, { force: true });
    const result = await provisionBeads({ cwd: project, agents: ['claude'] });
    expect(result.serverUp).toBe(true);
    const calls = readCalls(logFile);
    expect(calls.some((c) => c.args === 'dolt start')).toBe(false);
    expect(fs.readlinkSync(path.join(localBin, 'bd'))).toBe(fakeBd);
  });

  describe('spawn race + HOME backfill (BdAdapter.run, real spawn)', () => {
    const okScript = '#!/bin/sh\necho "ok HOME=$HOME"\n';
    let sleeps: number;

    beforeEach(() => {
      sleeps = 0;
    });
    afterEach(() => {
      _adapterSeam.sleep = savedSeams.adapterSleep;
    });

    it('retries a transient ENOENT (binary renamed into place mid-provision)', async () => {
      const late = path.join(root, 'late', 'bd');
      _adapterSeam.sleep = async () => {
        sleeps += 1;
        // The postinstall's atomic rename lands while we back off.
        const tmp = `${late}.tmp`;
        writeExecutable(tmp, okScript);
        fs.renameSync(tmp, late);
      };
      const res = await new BdAdapter({ binaryPath: late }).run(['ping']);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('ok');
      expect(sleeps).toBe(1);
    });

    it('retries a transient ETXTBSY (binary still open for write)', async (ctx) => {
      const busy = path.join(root, 'busy', 'bd');
      writeExecutable(busy, okScript);
      const fd = fs.openSync(busy, 'r+');
      // ETXTBSY on exec of a file open for writing is Linux behaviour; macOS
      // happily execs it. Probe the real kernel instead of assuming.
      const probe = spawnSync(busy, []);
      if ((probe.error as NodeJS.ErrnoException | undefined)?.code !== 'ETXTBSY') {
        fs.closeSync(fd);
        ctx.skip();
        return;
      }
      _adapterSeam.sleep = async () => {
        sleeps += 1;
        fs.closeSync(fd); // the writer finishes
      };
      const res = await new BdAdapter({ binaryPath: busy }).run(['dolt', 'start']);
      expect(res.code).toBe(0);
      expect(sleeps).toBe(1);
    });

    it('backfills HOME from the passwd entry when the process has none', async () => {
      const bin = path.join(root, 'homeless', 'bd');
      writeExecutable(bin, okScript);
      const prev = process.env.HOME;
      delete process.env.HOME;
      try {
        const expected = os.homedir();
        const res = await new BdAdapter({ binaryPath: bin }).run(['ping']);
        expect(expected).not.toBe('');
        expect(res.stdout.trim()).toBe(`ok HOME=${expected}`);
      } finally {
        process.env.HOME = prev;
      }
    });
  });
});
