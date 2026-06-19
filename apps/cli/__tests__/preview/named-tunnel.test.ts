import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, mkdirMock, writeFileMock } = vi.hoisted(() => ({
  spawnMock: vi.fn((_bin: string, _args: string[]) => ({ stdout: {}, stderr: {} })),
  mkdirMock: vi.fn(async (_path: string, _opts?: unknown) => undefined),
  writeFileMock: vi.fn(async (_path: string, _data: string, _opts?: unknown) => undefined),
}));

vi.mock('child_process', () => ({ spawn: spawnMock }));
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    default: { ...actual, mkdir: mkdirMock, writeFile: writeFileMock },
    mkdir: mkdirMock,
    writeFile: writeFileMock,
  };
});

import { decodeTunnelToken, spawnNamedTunnel } from '../../src/services/preview/cloudflared';

function makeToken(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('decodeTunnelToken', () => {
  it('decodes a {a,t,s} token into the cloudflared credentials shape', () => {
    const token = makeToken({ a: 'acct-tag', t: 'tunnel-uuid', s: 'super-secret' });
    expect(decodeTunnelToken(token)).toEqual({
      AccountTag: 'acct-tag',
      TunnelID: 'tunnel-uuid',
      TunnelSecret: 'super-secret',
    });
  });

  it('throws when a field is missing (caller falls back to quick tunnel)', () => {
    const token = makeToken({ a: 'acct-tag', t: 'tunnel-uuid' }); // no `s`
    expect(() => decodeTunnelToken(token)).toThrow();
  });

  it('throws on garbage that is not base64 JSON', () => {
    expect(() => decodeTunnelToken('not-a-real-token')).toThrow();
  });
});

describe('spawnNamedTunnel', () => {
  it('writes a 0600 credentials file and runs `tunnel run --credentials-file … --url … <id>`', async () => {
    const token = makeToken({ a: 'acct-tag', t: 'tunnel-uuid', s: 'super-secret' });

    await spawnNamedTunnel('/usr/bin/cloudflared', token, 5173);

    // credentials file written with the decoded creds + locked-down perms
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [credPath, contents, opts] = writeFileMock.mock.calls[0];
    expect(String(credPath)).toMatch(/tunnel-tunnel-uuid\.json$/);
    expect(JSON.parse(contents as string)).toEqual({
      AccountTag: 'acct-tag',
      TunnelID: 'tunnel-uuid',
      TunnelSecret: 'super-secret',
    });
    expect(opts).toMatchObject({ mode: 0o600 });

    // locally-managed run with --url so the box sets its own ingress
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('/usr/bin/cloudflared');
    expect(args).toEqual([
      'tunnel',
      'run',
      '--credentials-file',
      expect.stringMatching(/tunnel-tunnel-uuid\.json$/),
      '--url',
      'http://localhost:5173',
      'tunnel-uuid',
    ]);
  });
});
