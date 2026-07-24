import { describe, it, expect, vi } from 'vitest';
import { setupHeadroomForSelfHosted } from '../../src/commands/host-agent';

function fakeRunner() {
  const calls: { cmd: string; args: string[] }[] = [];
  return {
    calls,
    which: vi.fn().mockReturnValue(true),
    run: vi.fn(async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      // Version probe for resolveHeadroomPython: return 3.11 so the resolver
      // accepts the first candidate and pip install can proceed.
      if (args.length === 2 && args[0] === '-c' && args[1]?.includes('sys.version_info')) {
        return { code: 0, stdout: '3.11', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    }),
  };
}

describe('setupHeadroomForSelfHosted options', () => {
  // `modelsCached: () => false` forces the install path (a non-baked box) so
  // these assertions about the pip install are deterministic regardless of
  // whether the test machine happens to have the HF model cached.
  it('defaults to [proxy,code] (deploy path unchanged)', async () => {
    const r = fakeRunner();
    await setupHeadroomForSelfHosted('claude', r as never, { modelsCached: () => false });
    const pip = r.calls.find((c) => c.args.includes('install'));
    expect(pip?.args.some((a) => a === 'headroom-ai[proxy,code]')).toBe(true);
  });
  it('honors extras + emits ordered progress', async () => {
    const r = fakeRunner();
    const steps: string[] = [];
    await setupHeadroomForSelfHosted('claude', r as never, {
      extras: ['proxy', 'code', 'image'],
      onProgress: (s) => steps.push(s),
      modelsCached: () => false,
    });
    const pip = r.calls.find((c) => c.args.includes('install'));
    expect(pip?.args.some((a) => a === 'headroom-ai[proxy,code,image]')).toBe(true);
    expect(steps).toEqual(expect.arrayContaining(['pip', 'model', 'init', 'proxy']));
  });
  it('SKIPS pip install + model download on a pre-baked box (headroom present + models cached)', async () => {
    const r = fakeRunner(); // which() → truthy for every binary (incl. headroom)
    const steps: string[] = [];
    await setupHeadroomForSelfHosted('claude', r as never, {
      onProgress: (s) => steps.push(s),
      modelsCached: () => true,
    });
    // No pip install ran (the whole point of pre-baking the image)…
    expect(r.calls.some((c) => c.args.includes('install'))).toBe(false);
    // …no model pre-download python ran…
    expect(r.calls.some((c) => c.args[1]?.includes('snapshot_download'))).toBe(false);
    // …but progress + the init/proxy tail still fire so the UI + wiring match.
    expect(steps).toEqual(expect.arrayContaining(['pip', 'model', 'init', 'proxy']));
  });
});
