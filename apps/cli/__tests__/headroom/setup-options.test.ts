import { describe, it, expect, vi } from 'vitest';
import { setupHeadroomForSelfHosted } from '../../src/commands/host-agent';

function fakeRunner() {
  const calls: { cmd: string; args: string[] }[] = [];
  return {
    calls,
    which: vi.fn().mockReturnValue(true),
    run: vi.fn(async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: '', stderr: '' };
    }),
  };
}

describe('setupHeadroomForSelfHosted options', () => {
  it('defaults to [proxy,code] (deploy path unchanged)', async () => {
    const r = fakeRunner();
    await setupHeadroomForSelfHosted('claude', r as never);
    const pip = r.calls.find((c) => c.args.includes('install'));
    expect(pip?.args.some((a) => a === 'headroom-ai[proxy,code]')).toBe(true);
  });
  it('honors extras + emits ordered progress', async () => {
    const r = fakeRunner();
    const steps: string[] = [];
    await setupHeadroomForSelfHosted('claude', r as never, {
      extras: ['proxy', 'code', 'image'],
      onProgress: (s) => steps.push(s),
    });
    const pip = r.calls.find((c) => c.args.includes('install'));
    expect(pip?.args.some((a) => a === 'headroom-ai[proxy,code,image]')).toBe(true);
    expect(steps).toEqual(expect.arrayContaining(['pip', 'model', 'init', 'proxy']));
  });
});
