import { spawn } from 'child_process';
import { log } from '../services/logger';

/**
 * OS-detected fallback installer for `bd`, used only when the bundled
 * `@beads/bd` binary couldn't be resolved (postinstall failed behind a corp
 * proxy / air-gap / unsupported arch) AND `bd` isn't already on PATH. The
 * primary path is always the bundled binary — this is the safety net the spec
 * (§4.1) calls for.
 *
 * Per-OS strategy — never assumes a single platform:
 *   - win32         → `irm <install.ps1> | iex`   (PowerShell one-liner)
 *   - darwin/linux  → `curl -fsSL <install.sh> | bash`
 *
 * Codespaces are Linux → the install.sh path. The Windows path documents the
 * extra prereqs (Go 1.24+, Git for Windows) the PowerShell installer needs;
 * we surface a clear error rather than silently failing if they're missing.
 */

const INSTALL_SH_URL =
  'https://raw.githubusercontent.com/gastownhall/beads/main/scripts/install.sh';
const INSTALL_PS1_URL =
  'https://raw.githubusercontent.com/gastownhall/beads/main/install.ps1';

export type InstallPlatform = 'win32' | 'darwin' | 'linux';

export interface InstallStrategy {
  /** Executable to spawn. */
  command: string;
  /** argv handed to the executable (no shell string interpolation). */
  args: string[];
  /** Human description for logs / consent prompts. */
  description: string;
}

/**
 * Pure resolver: maps an `os.platform()` value to the installer strategy.
 * Separated from the spawn so it's trivially testable across all three OSes
 * without mocking child_process.
 *
 * Windows uses `powershell.exe -Command "irm <url> | iex"`. macOS/Linux pipe
 * `curl` into `bash` via `bash -c`. We pass the whole pipeline as a single
 * `-c` / `-Command` argument (not a shell-interpolated user string — the URL
 * is a constant), which is the idiomatic way to run these official one-liners.
 */
export function resolveInstallStrategy(platform: NodeJS.Platform): InstallStrategy {
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `irm ${INSTALL_PS1_URL} | iex`,
      ],
      description: `PowerShell: irm ${INSTALL_PS1_URL} | iex (requires Go 1.24+ and Git for Windows on PATH)`,
    };
  }
  // darwin + linux (+ any other POSIX) share the curl|bash installer.
  return {
    command: 'bash',
    args: ['-c', `curl -fsSL ${INSTALL_SH_URL} | bash`],
    description: `curl -fsSL ${INSTALL_SH_URL} | bash`,
  };
}

export interface InstallResult {
  ok: boolean;
  code: number;
  stderr: string;
}

export const _installSpawnSeam = {
  run: _defaultInstallSpawn,
};

function _defaultInstallSpawn(strategy: InstallStrategy): Promise<InstallResult> {
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
    proc.on('close', (code) =>
      resolve({ ok: code === 0, code: code ?? -1, stderr }),
    );
  });
}

/**
 * Run the OS-appropriate installer. The caller is responsible for obtaining
 * user consent before calling this (it executes a remote install script).
 * `platform` defaults to the host's `process.platform` but is injectable for
 * tests so we can assert each OS picks the right strategy.
 */
export async function installBd(
  platform: NodeJS.Platform = process.platform,
): Promise<InstallResult> {
  const strategy = resolveInstallStrategy(platform);
  log.info('beads', `installing bd via ${strategy.description}`);
  const result = await _installSpawnSeam.run(strategy);
  if (!result.ok) {
    log.warn(
      'beads',
      `bd install failed (code=${result.code}): ${result.stderr.slice(0, 200)}`,
    );
  }
  return result;
}
