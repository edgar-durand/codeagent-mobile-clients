import { describe, it, expect } from 'vitest';
import { KimiRuntimeStrategy } from '../../src/agents/kimi/runtime';
import type { OsStrategy } from '../../src/os';

// Inject a fake OsStrategy whose `findInPath` always misses so prepareLaunch
// takes the "not installed" throw path, and whose `id` drives the OS-aware
// install hint. Only `id` + `findInPath` are exercised here.
const fakeOs = (id: OsStrategy['id']): OsStrategy =>
  ({ id, findInPath: () => null }) as unknown as OsStrategy;

describe('KimiRuntimeStrategy prepareLaunch install hint (OS-aware)', () => {
  it('WINDOWS: install hint requires WSL (not a bare curl|bash)', async () => {
    const r = new KimiRuntimeStrategy(fakeOs('win32'));
    await expect(r.prepareLaunch()).rejects.toThrow(/WSL/i);
    // Windows users must be told to install inside WSL, then re-pair from WSL.
    await expect(r.prepareLaunch()).rejects.toThrow(/from WSL/i);
  });

  it('POSIX (linux): install hint is the plain curl|bash script, NOT the WSL message', async () => {
    const r = new KimiRuntimeStrategy(fakeOs('linux'));
    await expect(r.prepareLaunch()).rejects.toThrow(
      /curl -fsSL https:\/\/code\.kimi\.com\/kimi-code\/install\.sh \| bash/,
    );
    await expect(r.prepareLaunch()).rejects.not.toThrow(/WSL/i);
  });

  it('POSIX (darwin): also shows the curl|bash script, no WSL', async () => {
    const r = new KimiRuntimeStrategy(fakeOs('darwin'));
    await expect(r.prepareLaunch()).rejects.not.toThrow(/WSL/i);
  });
});
