import { describe, expect, it } from 'vitest';
import { announcedPortListening, announcedPorts, resolveServedAddress, stripAnsi } from '../src/services/preview/served-address';

// QA CodeAgent Box 2026-09-25: detection said 5173, vite.config pinned 5174 and
// Vite bound [::1] only; the proxy forwarded to 127.0.0.1:5173 → Cloudflare 502.
const VITE_OUT =
  '\x1b[32m  VITE v6.3.5\x1b[39m  ready in 812 ms\n\n' +
  '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5174\x1b[22m/\x1b[39m\n' +
  '  ➜  Network: use --host to expose\n';

const only =
  (...open: string[]) =>
  async (port: number, host: string) =>
    open.includes(`${host}:${port}`);

describe('announcedPorts', () => {
  it('reads the port Vite prints, through its ANSI colours', () => {
    expect(announcedPorts(VITE_OUT)).toEqual([5174]);
  });

  it('ignores remote URLs (an API proxy target is not where the app serves)', () => {
    expect(announcedPorts('proxy /api -> https://api.example.com:8443/\n')).toEqual([]);
  });

  it('puts the most recent announcement first (a restart on a new port)', () => {
    expect(announcedPorts('Local: http://localhost:3000/\nLocal: http://localhost:3001/')).toEqual([
      3001, 3000,
    ]);
  });
});

describe('resolveServedAddress', () => {
  it('forwards to the announced port on the IPv6 loopback the server actually bound', async () => {
    await expect(
      resolveServedAddress(VITE_OUT, 5173, { listening: only('::1:5174') }),
    ).resolves.toEqual({ host: '::1', port: 5174 });
  });

  it('falls back to the detected port when the output announces nothing', async () => {
    await expect(
      resolveServedAddress('', 3000, { listening: only('127.0.0.1:3000') }),
    ).resolves.toEqual({ host: '127.0.0.1', port: 3000 });
  });

  it('keeps the old target when nothing answers (never worse than before)', async () => {
    await expect(resolveServedAddress(VITE_OUT, 5173, { listening: only() })).resolves.toEqual({
      host: '127.0.0.1',
      port: 5173,
    });
  });
});

describe('announcedPortListening (readiness)', () => {
  it('is ready once the announced URL answers, whatever port the detection guessed', async () => {
    await expect(announcedPortListening(VITE_OUT, { listening: only('::1:5174') })).resolves.toBe(true);
  });

  it('never flips ready before the server announces anything', async () => {
    await expect(announcedPortListening('> nx run @dgi/shared:build', { listening: only('::1:5174') })).resolves.toBe(false);
  });

  it('waits while the announced port is not accepting yet', async () => {
    await expect(announcedPortListening(VITE_OUT, { listening: only() })).resolves.toBe(false);
  });
});

describe('stripAnsi', () => {
  it('leaves the plain text the error card should show', () => {
    expect(stripAnsi(VITE_OUT)).toContain('Local:   http://localhost:5174/');
    expect(stripAnsi(VITE_OUT)).not.toMatch(/\x1b|\[3\dm/);
  });
});
