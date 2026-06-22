/**
 * Self-hosted git tooling — make `gh` available + authenticated on the user's
 * own box so the agent can run GitHub operations (`gh pr create`, etc.), even
 * on a BARE box that has neither the `gh` CLI installed nor any GitHub account
 * configured.
 *
 * This is the self-hosted counterpart to what the codespace bootstrap does
 * server-side (apps/api-v2 `github-ssh.service.ts`). It is STRICTLY best-effort:
 * the persistent git credential helper installed by `configureGitCredentials`
 * (workspace.ts) already makes `git pull` / `git push` authenticate, so `gh`
 * is a bonus — a failure here must NEVER fail the deploy.
 *
 * Install method: the OFFICIAL STATIC BINARY from cli/cli releases. It needs no
 * apt-repo setup and no root (it lands in `~/.codeam/bin`), so it works across
 * distros and on macOS. Package-manager installs of `gh` are deliberately NOT
 * attempted — most distros require adding GitHub's repo first, which is brittle.
 */

import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../../services/logger';

/**
 * Minimal injectable subprocess runner (same shape as host-agent's
 * `HeadroomRunner`, redeclared here to avoid a circular import). `run` resolves
 * — never rejects — with the exit code + captured stderr. `input`, when set, is
 * written to the child's stdin then closed (used for `gh auth login --with-token`).
 */
export interface GitToolingRunner {
  which(cmd: string): boolean;
  run(
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number; input?: string },
  ): Promise<{ code: number | null; stderr: string }>;
}

/** Where we drop a downloaded `gh` binary (on PATH-prepend, never needs root).
 *  `CODEAM_BIN_DIR` overrides it (tests; pinned/relocated installs). */
export function codeamBinDir(): string {
  return process.env.CODEAM_BIN_DIR ?? path.join(os.homedir(), '.codeam', 'bin');
}

/** Pinned fallback used only when the releases API can't be reached. */
const FALLBACK_GH_VERSION = '2.62.0';
const RELEASE_API = 'https://api.github.com/repos/cli/cli/releases/latest';

/** Map process.arch → the arch token GitHub uses in its release asset names. */
function ghArch(): 'amd64' | 'arm64' | null {
  if (process.arch === 'x64') return 'amd64';
  if (process.arch === 'arm64') return 'arm64';
  return null;
}

/**
 * Resolve the latest published `gh` version (without the leading `v`). Uses the
 * user's token when provided to dodge unauthenticated rate limits; falls back
 * to {@link FALLBACK_GH_VERSION} on any failure.
 */
async function resolveLatestGhVersion(token?: string): Promise<string> {
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'codeam-cli',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(RELEASE_API, { headers });
    if (!res.ok) return FALLBACK_GH_VERSION;
    const body = (await res.json()) as { tag_name?: unknown };
    if (typeof body.tag_name === 'string' && body.tag_name) {
      return body.tag_name.replace(/^v/, '');
    }
    return FALLBACK_GH_VERSION;
  } catch {
    return FALLBACK_GH_VERSION;
  }
}

/** Download a URL to `dest` via fetch. Returns true on success. */
async function download(url: string, dest: string): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'codeam-cli' } });
    if (!res.ok || !res.body) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure `gh` is available, returning the command to invoke it (`'gh'` if it
 * was already on PATH, or the absolute path to the binary we installed), or
 * null if it could not be made available. NEVER throws.
 *
 * @param runner injectable subprocess runner (extraction shells out via it)
 * @param token  the user's GitHub token (used to avoid API rate limits)
 * @param deps   injectable I/O for tests (fetch + the binary copy)
 */
export async function ensureGhCli(
  runner: GitToolingRunner,
  token?: string,
  deps: {
    downloadFn?: (url: string, dest: string) => Promise<boolean>;
    resolveVersionFn?: (token?: string) => Promise<string>;
  } = {},
): Promise<string | null> {
  // Fast path: already installed.
  if (runner.which('gh')) return 'gh';

  const arch = ghArch();
  const platform = process.platform;
  if (arch === null || (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32')) {
    log.warn('host-agent', `gh auto-install unsupported on ${platform}/${process.arch} — skipping`);
    return null;
  }

  // OS-agnostic asset/binary selection. GitHub ships gh for linux/macOS/windows.
  const osToken = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'windows' : 'linux';
  const ext = platform === 'linux' ? 'tar.gz' : 'zip';
  const binaryName = platform === 'win32' ? 'gh.exe' : 'gh';

  const downloadFn = deps.downloadFn ?? download;
  const resolveVersionFn = deps.resolveVersionFn ?? resolveLatestGhVersion;

  try {
    const version = await resolveVersionFn(token);
    const asset = `gh_${version}_${osToken}_${arch}`;
    const url = `https://github.com/cli/cli/releases/download/v${version}/${asset}.${ext}`;

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-gh-'));
    const archive = path.join(tmpRoot, `${asset}.${ext}`);
    if (!(await downloadFn(url, archive))) {
      log.warn('host-agent', 'gh download failed — skipping (git pull/push still work via the credential helper)');
      return null;
    }

    // Extract with `tar -xf`: bsdtar (macOS + Windows 10+) handles .zip and GNU
    // tar (Linux) auto-detects the .tar.gz, so one command works on every OS —
    // no dependency on `unzip` being present.
    const extract = await runner.run('tar', ['-xf', archive, '-C', tmpRoot], { timeoutMs: 60_000 });
    if (extract.code !== 0) {
      log.warn('host-agent', `gh archive extraction failed (code=${String(extract.code)}) — skipping`);
      return null;
    }

    const extractedBin = path.join(tmpRoot, asset, 'bin', binaryName);
    if (!fs.existsSync(extractedBin)) {
      log.warn('host-agent', 'gh binary not found in the extracted archive — skipping');
      return null;
    }

    const binDir = codeamBinDir();
    fs.mkdirSync(binDir, { recursive: true });
    const target = path.join(binDir, binaryName);
    fs.copyFileSync(extractedBin, target);
    fs.chmodSync(target, 0o755); // no-op on Windows (NTFS ACLs) — harmless
    log.info('host-agent', `gh installed to ${target} (v${version})`);
    return target;
  } catch (e) {
    log.warn('host-agent', `gh auto-install errored: ${e instanceof Error ? e.message : String(e)} — skipping`);
    return null;
  }
}

/**
 * Authenticate `gh` with the user's token — but ONLY if it isn't already
 * logged in, so we never clobber an existing GitHub account the user set up on
 * their own box. Best-effort, never throws.
 */
export async function ensureGhAuth(
  runner: GitToolingRunner,
  ghCmd: string,
  token: string,
): Promise<void> {
  if (!token) return;
  try {
    // Clear any ambient GH_TOKEN/GITHUB_TOKEN so `gh auth status` reflects a
    // real stored login (not an env token) and `--with-token` is accepted.
    const status = await runner.run(ghCmd, ['auth', 'status'], { timeoutMs: 15_000 });
    if (status.code === 0) {
      log.info('host-agent', 'gh already authenticated — leaving the existing login untouched');
      return;
    }
    const login = await runner.run(ghCmd, ['auth', 'login', '--with-token'], {
      timeoutMs: 20_000,
      input: `${token}\n`,
    });
    if (login.code === 0) {
      log.info('host-agent', 'gh authenticated with the linked GitHub token');
    } else {
      log.warn('host-agent', `gh auth login failed (code=${String(login.code)}) — gh unauthenticated`);
    }
  } catch (e) {
    log.warn('host-agent', `gh auth errored: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Default runner backed by node's spawn — supports stdin `input` for
 * `gh auth login --with-token`. Mirrors host-agent's `defaultHeadroomRunner`
 * but adds the stdin path. Never rejects.
 */
export const defaultGitToolingRunner: GitToolingRunner = {
  which(cmd: string): boolean {
    try {
      // OS-agnostic command probe: `where` on Windows, `which` elsewhere.
      const probe = process.platform === 'win32' ? 'where' : 'which';
      execFileSync(probe, [cmd], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },
  run(cmd, args, opts = {}): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      let settled = false;
      const done = (code: number | null): void => {
        if (settled) return;
        settled = true;
        resolve({ code, stderr });
      };
      child.stderr?.on('data', (b: Buffer) => {
        stderr += b.toString();
      });
      if (opts.input !== undefined) {
        child.stdin?.end(opts.input);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          try {
            child.kill('SIGTERM');
          } catch {
            /* already dead */
          }
          done(null);
        }, opts.timeoutMs);
      }
      child.once('exit', (code) => {
        if (timer) clearTimeout(timer);
        done(code);
      });
      child.once('error', () => {
        if (timer) clearTimeout(timer);
        done(null);
      });
    });
  },
};
