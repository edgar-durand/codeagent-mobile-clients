import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log } from '../services/logger';

/**
 * OS-detected installer for the standalone `dolt` CLI. Required because the
 * npm-bundled `@beads/bd` is the SERVER-mode build: every DB operation — and
 * `bd remember` / `bd memories` / `bd prime`(+memories) in particular — needs
 * the `dolt` binary + a running `dolt sql-server`. Without it, beads memory
 * silently can't work (spec §3c, D15). The provisioner calls this when `dolt`
 * isn't already on PATH; consent is the caller's job.
 *
 * Cross-OS parity is mandatory (Mac + Linux + Windows), using the OFFICIAL
 * Dolt installers (https://www.dolthub.com/docs/introduction/installation):
 *   - darwin  → `brew install dolt`            (no sudo, no hang; primary)
 *   - linux   → official sudo `curl … install.sh | sudo bash` (→ /usr/local/bin;
 *               codespaces are Linux and typically root/passwordless-sudo)
 *   - win32   → PowerShell: download the official MSI + silent `msiexec`.
 *               NOT `winget` — it may not be installed (Edgar, 2026-06-10).
 *               winget/choco/scoop remain opportunistic fallbacks only.
 *
 * Mirrors `install-bd.ts` exactly (same InstallStrategy/InstallResult shapes,
 * same `_doltInstallSpawnSeam` test seam, same non-fatal logging contract).
 */

/** Official Dolt release artifacts (latest, resolved by GitHub redirect). */
const DOLT_INSTALL_SH_URL =
  'https://github.com/dolthub/dolt/releases/latest/download/install.sh';
const DOLT_MSI_URL =
  'https://github.com/dolthub/dolt/releases/latest/download/dolt-windows-amd64.msi';

export interface InstallStrategy {
  /** Executable to spawn. */
  command: string;
  /** argv handed to the executable (no shell string interpolation). */
  args: string[];
  /** Human description for logs / consent prompts. */
  description: string;
}

/**
 * Pure resolver: maps an `os.platform()` value to the dolt installer strategy.
 * Separated from the spawn so it's trivially testable across all three OSes
 * without mocking child_process.
 */
export function resolveDoltInstallStrategy(platform: NodeJS.Platform): InstallStrategy {
  if (platform === 'win32') {
    // PowerShell-only: fetch the official MSI and install it silently. No
    // package-manager dependency (winget may be absent). If msiexec needs
    // elevation, it returns a non-zero code → surfaced by the caller, which
    // can then offer the elevation-free ZIP fallback.
    const script = [
      `$ErrorActionPreference='Stop';`,
      `$u='${DOLT_MSI_URL}';`,
      `$o="$env:TEMP\\dolt-install.msi";`,
      `Invoke-WebRequest -Uri $u -OutFile $o;`,
      `Start-Process msiexec.exe -ArgumentList '/i',('"'+$o+'"'),'/quiet','/norestart' -Wait`,
    ].join(' ');
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ],
      description: 'PowerShell: download official dolt MSI + silent msiexec',
    };
  }
  if (platform === 'darwin') {
    // brew avoids sudo (no password prompt / hang). curl install.sh is the
    // documented fallback when brew is absent (the caller decides).
    return {
      command: 'brew',
      args: ['install', 'dolt'],
      description: 'brew install dolt',
    };
  }
  // linux (+ any other POSIX): the official install.sh, which detects arch and
  // installs to /usr/local/bin. Needs sudo for that path; codespaces run as
  // root / passwordless-sudo. A sudo password prompt would surface as a
  // non-zero exit rather than hang under a non-interactive spawn.
  return {
    command: 'bash',
    args: ['-c', `curl -L ${DOLT_INSTALL_SH_URL} | sudo bash`],
    description: `curl -L ${DOLT_INSTALL_SH_URL} | sudo bash (→ /usr/local/bin)`,
  };
}

export interface InstallResult {
  ok: boolean;
  code: number;
  stderr: string;
}

/** Official Dolt release tarball/zip base (latest, resolved by GitHub redirect). */
const DOLT_RELEASE_BASE = 'https://github.com/dolthub/dolt/releases/latest/download';

/**
 * Map Node's `process.platform`/`process.arch` to Dolt's release platform tuple
 * (e.g. `linux-amd64`, `darwin-arm64`, `windows-amd64`). Returns null for an
 * arch Dolt ships no prebuilt for (Windows arm64), so the caller can give up
 * gracefully. Mirrors the official install.sh's `PLATFORM_TUPLE` logic.
 */
export function doltPlatformTuple(
  platform: NodeJS.Platform,
  arch: string,
): string | null {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
  const a = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null;
  if (!a) return null;
  if (os === 'windows' && a !== 'amd64') return null; // Dolt ships windows-amd64 only
  return `${os}-${a}`;
}

/**
 * No-sudo fallback strategy: download the official Dolt release archive and
 * extract just the `dolt` binary into a USER-writable, on-PATH dir (e.g.
 * `~/.local/bin` in a locked-down container without sudo / writable
 * `/usr/local/bin`). Returns null when Dolt ships no artifact for this
 * platform tuple. Pure (no spawn) so it's unit-testable per OS.
 */
export function resolveDoltTarballStrategy(
  targetDir: string,
  platform: NodeJS.Platform,
  arch: string,
): InstallStrategy | null {
  const tuple = doltPlatformTuple(platform, arch);
  if (!tuple) return null;

  if (platform === 'win32') {
    const url = `${DOLT_RELEASE_BASE}/dolt-${tuple}.zip`;
    const script = [
      `$ErrorActionPreference='Stop';`,
      `New-Item -ItemType Directory -Force -Path '${targetDir}' | Out-Null;`,
      `$u='${url}';`,
      `$o="$env:TEMP\\dolt-cs.zip";`,
      `Invoke-WebRequest -Uri $u -OutFile $o;`,
      `$x="$env:TEMP\\dolt-cs";`,
      `Expand-Archive -Path $o -DestinationPath $x -Force;`,
      `Copy-Item "$x\\dolt-${tuple}\\bin\\dolt.exe" '${targetDir}\\dolt.exe' -Force`,
    ].join(' ');
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      description: `download dolt ${tuple} zip → ${targetDir} (no sudo)`,
    };
  }

  // posix (linux/codespace + macOS): stream the tarball through tar, keeping
  // only `dolt-<tuple>/bin/dolt` (strip the leading two path components).
  const url = `${DOLT_RELEASE_BASE}/dolt-${tuple}.tar.gz`;
  const cmd =
    `mkdir -p "${targetDir}" && ` +
    `curl -fsSL "${url}" | tar -xz -C "${targetDir}" --strip-components=2 "dolt-${tuple}/bin/dolt" && ` +
    `chmod +x "${targetDir}/dolt"`;
  return {
    command: 'bash',
    args: ['-c', cmd],
    description: `download dolt ${tuple} tarball → ${targetDir} (no sudo)`,
  };
}

/**
 * Run the no-sudo tarball/zip fallback into `targetDir`. Strictly non-fatal;
 * returns `ok:false` when Dolt ships no artifact for this platform or the
 * download/extract fails. The caller then re-probes `ensureDoltResolvable`
 * (which scans `~/.local/bin`) and degrades to "beads memory off this run".
 */
export async function installDoltToDir(
  targetDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<InstallResult> {
  const strategy = resolveDoltTarballStrategy(targetDir, platform, arch);
  if (!strategy) {
    log.warn('beads', `no dolt prebuilt for ${platform}/${arch} — cannot fall back`);
    return { ok: false, code: -1, stderr: `unsupported platform ${platform}/${arch}` };
  }
  log.info('beads', `dolt fallback: ${strategy.description}`);
  const result = await _doltInstallSpawnSeam.run(strategy);
  if (!result.ok) {
    log.warn('beads', `dolt tarball fallback failed (code=${result.code}): ${result.stderr.slice(0, 200)}`);
  }
  return result;
}

/**
 * Filesystem/env seam for the PATH-resolution helper, isolated so tests drive
 * it without touching the real filesystem or `process.env`.
 */
export const _doltPathSeam = {
  homedir: (): string => os.homedir(),
  getPath: (): string => process.env.PATH ?? '',
  setPath: (p: string): void => {
    process.env.PATH = p;
  },
  exists: (p: string): boolean => {
    try {
      fs.accessSync(p, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/** The dolt binary name(s) to probe per platform. */
function doltBinaryNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['dolt.exe', 'dolt.cmd', 'dolt'] : ['dolt'];
}

/**
 * Well-known directories the official installers drop `dolt` into, which may
 * NOT be on a non-login process PATH (the codespace gotcha: the official
 * install.sh hard-installs to `/usr/local/bin`, and the bundled-node CLI runs
 * with a transient PATH that can omit it — same root cause as the bd-on-PATH
 * symlink fix). `/opt/homebrew/bin` covers Apple-Silicon brew.
 */
function knownDoltDirs(platform: NodeJS.Platform): string[] {
  // Use the path flavour for the TARGET platform (not the host) so the helper
  // behaves identically whether it runs on the platform or is unit-tested
  // cross-OS (e.g. a Windows CI runner exercising the linux path).
  const P = platform === 'win32' ? path.win32 : path.posix;
  const home = _doltPathSeam.homedir();
  if (platform === 'win32') {
    return [
      'C:\\Program Files\\Dolt\\bin',
      home ? P.join(home, 'AppData', 'Local', 'Programs', 'dolt', 'bin') : '',
    ].filter(Boolean);
  }
  return [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    home ? P.join(home, '.local', 'bin') : '',
    home ? P.join(home, 'bin') : '',
  ].filter(Boolean);
}

/**
 * True when `dolt` is resolvable for the CURRENT process — checking `$PATH`
 * first, then well-known install dirs. If found in a known dir that isn't on
 * `$PATH` (the codespace case after `sudo install.sh` → `/usr/local/bin`), it
 * **prepends that dir to `process.env.PATH`** so the immediately-following
 * `bd dolt start` (and the agent, which inherits our env) resolves it. The
 * AGENT'S `bd prime` does NOT need `dolt` on PATH — once the shared server is
 * up it connects over TCP — but the provisioner does, to start that server.
 */
export function ensureDoltResolvable(platform: NodeJS.Platform = process.platform): boolean {
  // Path flavour + PATH separator for the TARGET platform (the arg), so probing
  // is correct whether called on-platform or unit-tested cross-OS.
  const P = platform === 'win32' ? path.win32 : path.posix;
  const delim = platform === 'win32' ? ';' : ':';
  const names = doltBinaryNames(platform);
  const pathDirs = _doltPathSeam.getPath().split(delim).filter(Boolean);
  for (const dir of pathDirs) {
    for (const n of names) {
      if (_doltPathSeam.exists(P.join(dir, n))) return true;
    }
  }
  // Not on PATH — scan known install dirs and prepend the first that has dolt.
  for (const dir of knownDoltDirs(platform)) {
    for (const n of names) {
      if (_doltPathSeam.exists(P.join(dir, n))) {
        _doltPathSeam.setPath(`${dir}${delim}${_doltPathSeam.getPath()}`);
        log.info('beads', `dolt found in ${dir} (not on PATH) — prepended to process PATH`);
        return true;
      }
    }
  }
  return false;
}

export const _doltInstallSpawnSeam = {
  run: _defaultDoltInstallSpawn,
};

function _defaultDoltInstallSpawn(strategy: InstallStrategy): Promise<InstallResult> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(strategy.command, strategy.args, { env: process.env });
    } catch (err) {
      resolve({ ok: false, code: -1, stderr: (err as Error).message });
      return;
    }
    let stderr = '';
    proc.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on('error', (err) => resolve({ ok: false, code: -1, stderr: err.message }));
    proc.on('close', (code) => resolve({ ok: code === 0, code: code ?? -1, stderr }));
  });
}

/**
 * Run the OS-appropriate dolt installer. The caller is responsible for
 * obtaining user consent before calling this (it executes a remote install /
 * downloads an MSI). `platform` defaults to the host's `process.platform` but
 * is injectable for tests. Strictly non-fatal: a failure logs a warning and
 * returns `ok:false` — the provisioner degrades to "beads memory unavailable
 * this run", never aborting the agent.
 */
export async function installDolt(
  platform: NodeJS.Platform = process.platform,
): Promise<InstallResult> {
  const strategy = resolveDoltInstallStrategy(platform);
  log.info('beads', `installing dolt via ${strategy.description}`);
  const result = await _doltInstallSpawnSeam.run(strategy);
  if (!result.ok) {
    log.warn(
      'beads',
      `dolt install failed (code=${result.code}): ${result.stderr.slice(0, 200)}`,
    );
  }
  return result;
}
