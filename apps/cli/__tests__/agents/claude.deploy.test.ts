import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeDeployStrategy } from '../../src/agents/claude/deploy';

// detectLocalCredentials reads filesystem + Keychain; we mock at the os/fs level.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    statSync: vi.fn(),
  };
});
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    platform: vi.fn(),
    homedir: vi.fn(() => '/home/test'),
  };
});

import * as fs from 'node:fs';
import * as os from 'node:os';

describe('ClaudeDeployStrategy', () => {
  const strategy = new ClaudeDeployStrategy();

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.statSync).mockReset();
    vi.mocked(os.platform).mockReset();
  });

  it('id === claude', () => {
    expect(strategy.id).toBe('claude');
  });

  describe('detectLocalCredentials', () => {
    it('returns none when ~/.claude has no creds and not on macOS', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(os.platform).mockReturnValue('linux');
      const r = await strategy.detectLocalCredentials();
      expect(r.source).toBe('none');
    });

    it('returns flat-file when ~/.claude/.credentials.json exists', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith('.credentials.json'));
      vi.mocked(os.platform).mockReturnValue('linux');
      const r = await strategy.detectLocalCredentials();
      expect(r.source).toBe('flat-file');
      expect(r.description).toContain('credentials.json');
    });
  });
});
