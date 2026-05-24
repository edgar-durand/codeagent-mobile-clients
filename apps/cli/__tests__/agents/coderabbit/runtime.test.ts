import { describe, it, expect } from 'vitest';
import { CoderabbitRuntimeStrategy } from '../../../src/agents/coderabbit/runtime';
import { LinuxOsStrategy, Win32OsStrategy } from '../../../src/os';

describe('CoderabbitRuntimeStrategy contract', () => {
  it('reports mode="batch" and id="coderabbit"', () => {
    const r = new CoderabbitRuntimeStrategy(new LinuxOsStrategy());
    expect(r.mode).toBe('batch');
    expect(r.id).toBe('coderabbit');
    expect(r.meta.displayName).toBe('CodeRabbit');
  });

  it('getDefaultArgs returns the review subcommand', () => {
    const r = new CoderabbitRuntimeStrategy(new LinuxOsStrategy());
    expect(r.getDefaultArgs()).toEqual(['review']);
  });

  it('credentialLocator points at ~/.coderabbit/auth.json', () => {
    const loc = new CoderabbitRuntimeStrategy(new LinuxOsStrategy()).credentialLocator();
    expect(loc.publicId).toBe('coderabbit');
    expect(loc.vendor).toBe('CodeRabbit');
    expect(loc.hint).toBe('~/.coderabbit/auth.json');
    expect(loc.watchPaths()[0].endsWith('.coderabbit/auth.json')).toBe(true);
  });

  it('prepareInvocation throws when the binary is not on PATH', async () => {
    // LinuxOsStrategy's findInPath honors process.env.PATH; we scope
    // PATH to an empty dir so `coderabbit` is guaranteed missing.
    const originalPath = process.env.PATH;
    process.env.PATH = '/var/empty';
    try {
      const r = new CoderabbitRuntimeStrategy(new LinuxOsStrategy());
      await expect(r.prepareInvocation({ prRef: '123' })).rejects.toThrow(
        /not on PATH/i,
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('parseOutput funnels stdout through parseReview', () => {
    const r = new CoderabbitRuntimeStrategy(new LinuxOsStrategy());
    const out = r.parseOutput({
      exitCode: 0,
      stdout: 'src/x.ts:5: warning: nope',
      stderr: '',
    });
    expect(out.exitCode).toBe(0);
    expect(out.hunks?.length).toBe(1);
    expect(out.hunks?.[0]?.path).toBe('src/x.ts');
    expect(out.markdown).toContain('src/x.ts:5');
  });

  it('rejects Win32 install with a WSL-only message', async () => {
    // The launcher's ensureInstalled probes os.findInPath('coderabbit')
    // first; with PATH scoped to an empty dir on a Win32 strategy, the
    // installer falls into the WSL-only branch (which returns false +
    // prints the guidance).
    const originalPath = process.env.PATH;
    process.env.PATH = '/var/empty';
    const origError = console.error;
    let captured = '';
    console.error = (msg: unknown) => { captured += String(msg); };
    try {
      const r = new CoderabbitRuntimeStrategy(new Win32OsStrategy());
      const launcher = r.loginLauncher();
      const ok = await launcher.ensureInstalled();
      expect(ok).toBe(false);
      expect(captured).toMatch(/WSL/);
    } finally {
      process.env.PATH = originalPath;
      console.error = origError;
    }
  });
});
