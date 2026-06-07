import fs from 'fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import which from 'which';
import {
  resolveCloudflared,
  waitForCloudflaredReady,
} from '../../src/services/preview/cloudflared';

const {
  resolve4Mock,
  resolve6Mock,
  setServersMock,
  lookupMock,
} = vi.hoisted(() => ({
  resolve4Mock: vi.fn(),
  resolve6Mock: vi.fn(),
  setServersMock: vi.fn(),
  lookupMock: vi.fn(),
}));

vi.mock('dns/promises', () => ({
  default: { lookup: lookupMock },
  lookup: lookupMock,
  Resolver: function MockResolver() {
    return {
      resolve4: resolve4Mock,
      resolve6: resolve6Mock,
      setServers: setServersMock,
    };
  },
}));

vi.mock('which');
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    default: {
      ...actual,
      access: vi.fn(),
      mkdir: vi.fn(),
    },
    access: vi.fn(),
    mkdir: vi.fn(),
  };
});

describe('resolveCloudflared', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns the PATH-resident binary when available', async () => {
    vi.mocked(which).mockResolvedValue('/usr/local/bin/cloudflared' as never);
    expect(await resolveCloudflared()).toBe('/usr/local/bin/cloudflared');
  });

  it('falls back to the cached binary when PATH lookup fails', async () => {
    vi.mocked(which).mockRejectedValue(new Error('not found'));
    vi.mocked(fs.access).mockResolvedValue(undefined);
    const result = await resolveCloudflared({ skipDownload: true });
    // Windows uses backslashes — match either separator so the
    // assertion is OS-agnostic.
    expect(result).toMatch(/[/\\]\.codeam[/\\]bin[/\\]cloudflared$/);
  });

  it('throws a clear error when binary missing and skipDownload=true', async () => {
    vi.mocked(which).mockRejectedValue(new Error('not found'));
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
    await expect(resolveCloudflared({ skipDownload: true })).rejects.toThrow(
      /cloudflared not installed/,
    );
  });
});

describe('waitForCloudflaredReady', () => {
  beforeEach(() => {
    resolve4Mock.mockReset();
    resolve6Mock.mockReset();
    setServersMock.mockReset();
    lookupMock.mockReset();
  });

  const enotfound = Object.assign(new Error('queryA ENOTFOUND'), {
    code: 'ENOTFOUND',
  });
  const enodata = Object.assign(new Error('queryAaaa ENODATA'), {
    code: 'ENODATA',
  });

  it('resolves as soon as dns.lookup (OS resolver) succeeds — the fast path', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '104.16.230.132', family: 4 }]);
    resolve4Mock.mockRejectedValueOnce(enotfound);
    resolve6Mock.mockRejectedValueOnce(enotfound);
    await expect(
      waitForCloudflaredReady('https://example.trycloudflare.com', 1_000),
    ).resolves.toBeUndefined();
    expect(lookupMock).toHaveBeenCalledWith('example.trycloudflare.com', { all: true });
  });

  it('resolves via c-ares A fallback when dns.lookup is broken', async () => {
    lookupMock.mockRejectedValueOnce(enotfound);
    resolve4Mock.mockResolvedValueOnce(['104.16.230.132']);
    resolve6Mock.mockRejectedValueOnce(enodata);
    await expect(
      waitForCloudflaredReady('https://example.trycloudflare.com', 1_000),
    ).resolves.toBeUndefined();
  });

  it('resolves via c-ares AAAA fallback (Quick Tunnels are often v6-only)', async () => {
    lookupMock.mockRejectedValueOnce(enotfound);
    resolve4Mock.mockRejectedValueOnce(enodata);
    resolve6Mock.mockResolvedValueOnce(['2606:4700::6810:e784']);
    await expect(
      waitForCloudflaredReady('https://example.trycloudflare.com', 1_000),
    ).resolves.toBeUndefined();
  });

  it('retries past ENOTFOUND across all three probes while DNS propagates', async () => {
    lookupMock
      .mockRejectedValueOnce(enotfound)
      .mockRejectedValueOnce(enotfound)
      .mockResolvedValueOnce([{ address: '104.16.231.132', family: 4 }]);
    resolve4Mock.mockRejectedValue(enotfound);
    resolve6Mock.mockRejectedValue(enotfound);
    await expect(
      waitForCloudflaredReady('https://example.trycloudflare.com', 10_000),
    ).resolves.toBeUndefined();
    expect(lookupMock).toHaveBeenCalledTimes(3);
  });

  it('throws when the deadline expires before any probe resolves', async () => {
    lookupMock.mockRejectedValue(enotfound);
    resolve4Mock.mockRejectedValue(enotfound);
    resolve6Mock.mockRejectedValue(enotfound);
    await expect(
      waitForCloudflaredReady('https://example.trycloudflare.com', 200),
    ).rejects.toThrow(/did not resolve within 200ms/);
  });
});
