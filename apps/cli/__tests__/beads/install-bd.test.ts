import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveInstallStrategy,
  installBd,
  _installSpawnSeam,
} from '../../src/beads/install-bd';

describe('resolveInstallStrategy — per OS', () => {
  it('win32 → PowerShell irm install.ps1 | iex', () => {
    const s = resolveInstallStrategy('win32');
    expect(s.command).toBe('powershell.exe');
    const joined = s.args.join(' ');
    expect(joined).toContain('irm');
    expect(joined).toContain('install.ps1');
    expect(joined).toContain('| iex');
    // Bypass policy so a locked-down profile doesn't block the installer.
    expect(s.args).toContain('Bypass');
  });

  it('darwin → curl install.sh | bash', () => {
    const s = resolveInstallStrategy('darwin');
    expect(s.command).toBe('bash');
    const joined = s.args.join(' ');
    expect(joined).toContain('curl -fsSL');
    expect(joined).toContain('install.sh');
    expect(joined).toContain('| bash');
  });

  it('linux → curl install.sh | bash (same POSIX path, used by codespaces)', () => {
    const s = resolveInstallStrategy('linux');
    expect(s.command).toBe('bash');
    expect(s.args.join(' ')).toContain('install.sh');
  });

  it('win32 and posix strategies differ (never assumes a single OS)', () => {
    expect(resolveInstallStrategy('win32').command).not.toBe(
      resolveInstallStrategy('linux').command,
    );
  });
});

describe('installBd', () => {
  afterEach(() => vi.restoreAllMocks());

  it('spawns the win32 strategy when platform=win32', async () => {
    const spy = vi
      .spyOn(_installSpawnSeam, 'run')
      .mockResolvedValue({ ok: true, code: 0, stderr: '' });
    const res = await installBd('win32');
    expect(res.ok).toBe(true);
    expect(spy.mock.calls[0][0].command).toBe('powershell.exe');
  });

  it('spawns the posix strategy when platform=linux', async () => {
    const spy = vi
      .spyOn(_installSpawnSeam, 'run')
      .mockResolvedValue({ ok: true, code: 0, stderr: '' });
    await installBd('linux');
    expect(spy.mock.calls[0][0].command).toBe('bash');
  });

  it('reports failure (non-zero exit) without throwing', async () => {
    vi.spyOn(_installSpawnSeam, 'run').mockResolvedValue({
      ok: false,
      code: 1,
      stderr: 'proxy blocked',
    });
    const res = await installBd('darwin');
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain('proxy');
  });
});
