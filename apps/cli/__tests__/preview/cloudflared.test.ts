import fs from 'fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import which from 'which';
import { resolveCloudflared } from '../../src/services/preview/cloudflared';

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
