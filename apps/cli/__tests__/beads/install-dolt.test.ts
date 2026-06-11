import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveDoltInstallStrategy,
  installDolt,
  _doltInstallSpawnSeam,
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
