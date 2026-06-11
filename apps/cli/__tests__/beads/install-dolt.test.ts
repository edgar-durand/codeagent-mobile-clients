import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveDoltInstallStrategy,
  installDolt,
  ensureDoltResolvable,
  _doltInstallSpawnSeam,
  _doltPathSeam,
} from '../../src/beads/install-dolt';

describe('resolveDoltInstallStrategy — per OS (cross-OS parity, official Dolt installers)', () => {
  it('darwin → brew install dolt (primary, no sudo)', () => {
    const s = resolveDoltInstallStrategy('darwin');
    expect(s.command).toBe('brew');
    expect(s.args).toEqual(['install', 'dolt']);
  });

  it('linux → official sudo curl install.sh (→ /usr/local/bin, used by codespaces)', () => {
    const s = resolveDoltInstallStrategy('linux');
    expect(s.command).toBe('bash');
    expect(s.args[0]).toBe('-c');
    const joined = s.args.join(' ');
    expect(joined).toContain('github.com/dolthub/dolt/releases/latest/download/install.sh');
    expect(joined).toContain('curl -L');
  });

  it('win32 → PowerShell MSI install (NOT winget — may be absent)', () => {
    const s = resolveDoltInstallStrategy('win32');
    expect(s.command).toBe('powershell.exe');
    const joined = s.args.join(' ');
    expect(joined).toContain('dolt-windows-amd64.msi');
    expect(joined).toContain('msiexec');
    // winget is fallback-only, never the primary strategy (Edgar: may not be installed).
    expect(joined).not.toContain('winget');
    // Bypass policy so a locked-down profile doesn't block the installer (parity with install-bd).
    expect(s.args).toContain('Bypass');
  });
});

describe('installDolt', () => {
  afterEach(() => {
    _doltInstallSpawnSeam.run = originalRun;
  });
  const originalRun = _doltInstallSpawnSeam.run;

  it('returns ok on a zero-exit install', async () => {
    _doltInstallSpawnSeam.run = vi.fn(async () => ({ ok: true, code: 0, stderr: '' }));
    const r = await installDolt('darwin');
    expect(r.ok).toBe(true);
  });

  it('returns not-ok (non-fatal) on a failed install', async () => {
    _doltInstallSpawnSeam.run = vi.fn(async () => ({ ok: false, code: 1, stderr: 'boom' }));
    const r = await installDolt('linux');
    expect(r.ok).toBe(false);
    expect(r.code).toBe(1);
  });
});

describe('ensureDoltResolvable — codespace PATH hardening', () => {
  afterEach(() => vi.restoreAllMocks());

  it('true when dolt is already on PATH (no PATH mutation)', () => {
    vi.spyOn(_doltPathSeam, 'getPath').mockReturnValue('/usr/bin:/bin');
    const setPath = vi.spyOn(_doltPathSeam, 'setPath');
    vi.spyOn(_doltPathSeam, 'exists').mockImplementation((p) => p === '/usr/bin/dolt');
    expect(ensureDoltResolvable('linux')).toBe(true);
    expect(setPath).not.toHaveBeenCalled();
  });

  it('codespace: dolt in /usr/local/bin but NOT on PATH → prepends it and resolves', () => {
    vi.spyOn(_doltPathSeam, 'homedir').mockReturnValue('/home/codespace');
    vi.spyOn(_doltPathSeam, 'getPath').mockReturnValue('/usr/bin:/bin'); // no /usr/local/bin
    const setPath = vi.spyOn(_doltPathSeam, 'setPath');
    vi.spyOn(_doltPathSeam, 'exists').mockImplementation((p) => p === '/usr/local/bin/dolt');
    expect(ensureDoltResolvable('linux')).toBe(true);
    expect(setPath).toHaveBeenCalledWith('/usr/local/bin:/usr/bin:/bin');
  });

  it('false when dolt is nowhere (PATH nor known dirs)', () => {
    vi.spyOn(_doltPathSeam, 'homedir').mockReturnValue('/home/u');
    vi.spyOn(_doltPathSeam, 'getPath').mockReturnValue('/usr/bin:/bin');
    vi.spyOn(_doltPathSeam, 'exists').mockReturnValue(false);
    expect(ensureDoltResolvable('linux')).toBe(false);
  });
});
