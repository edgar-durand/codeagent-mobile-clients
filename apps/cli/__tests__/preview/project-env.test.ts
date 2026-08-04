import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the vault transport + repo-identity so the module logic is tested in
// isolation from the network and git.
vi.mock('../../src/services/pairing.service', () => ({
  pushProjectEnv: vi.fn(),
  pullProjectEnv: vi.fn(),
}));
vi.mock('../../src/beads/project-key', () => ({
  deriveProjectIdentity: vi.fn(() => ({
    projectKey: 'github.com/org/repo',
    projectLabel: 'org/repo',
  })),
}));

import { pushProjectEnv, pullProjectEnv } from '../../src/services/pairing.service';
import {
  restoreProjectEnvIfMissing,
  syncProjectEnvUp,
} from '../../src/services/project-env';

const pushMock = vi.mocked(pushProjectEnv);
const pullMock = vi.mocked(pullProjectEnv);

const CTX = { sessionId: 's1', pluginId: 'p1', pluginAuthToken: 'tok' };
const ENV = 'DATABASE_URL=postgres://localhost/app\nSTRIPE_KEY=sk_live_x\n';

describe('project-env CLI service', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-env-'));
    pushMock.mockReset().mockResolvedValue({ ok: true });
    pullMock.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('syncProjectEnvUp', () => {
    it('pushes the .env content + parsed var count', async () => {
      fs.writeFileSync(path.join(dir, '.env'), ENV);
      await syncProjectEnvUp(dir, CTX);
      expect(pushMock).toHaveBeenCalledTimes(1);
      expect(pushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 's1',
          pluginId: 'p1',
          pluginAuthToken: 'tok',
          projectKey: 'github.com/org/repo',
          projectLabel: 'org/repo',
          content: ENV,
          keyCount: 2,
        }),
      );
    });

    it('no-ops when there is no .env', async () => {
      await syncProjectEnvUp(dir, CTX);
      expect(pushMock).not.toHaveBeenCalled();
    });

    it('no-ops without a plugin auth token (older/unauthed session)', async () => {
      fs.writeFileSync(path.join(dir, '.env'), ENV);
      await syncProjectEnvUp(dir, { ...CTX, pluginAuthToken: undefined });
      expect(pushMock).not.toHaveBeenCalled();
    });

    it('never throws when the push fails', async () => {
      fs.writeFileSync(path.join(dir, '.env'), ENV);
      pushMock.mockResolvedValue({ ok: false, status: 500, message: 'boom' });
      await expect(syncProjectEnvUp(dir, CTX)).resolves.toBeUndefined();
    });
  });

  describe('restoreProjectEnvIfMissing', () => {
    it('writes the pulled .env when none exists and returns true', async () => {
      pullMock.mockResolvedValue({ content: ENV, keyCount: 2 });
      const restored = await restoreProjectEnvIfMissing(dir, CTX);
      expect(restored).toBe(true);
      expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe(ENV);
    });

    it('NEVER overwrites an existing .env (working copy wins)', async () => {
      fs.writeFileSync(path.join(dir, '.env'), 'LOCAL=1\n');
      pullMock.mockResolvedValue({ content: ENV, keyCount: 2 });
      const restored = await restoreProjectEnvIfMissing(dir, CTX);
      expect(restored).toBe(false);
      expect(pullMock).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('LOCAL=1\n');
    });

    it('returns false on a vault miss (no stored env)', async () => {
      pullMock.mockResolvedValue(null);
      expect(await restoreProjectEnvIfMissing(dir, CTX)).toBe(false);
      expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
    });

    it('no-ops without a plugin auth token', async () => {
      expect(await restoreProjectEnvIfMissing(dir, { ...CTX, pluginAuthToken: undefined })).toBe(
        false,
      );
      expect(pullMock).not.toHaveBeenCalled();
    });

    it('leaves no temp file behind after a successful restore', async () => {
      pullMock.mockResolvedValue({ content: ENV, keyCount: 2 });
      await restoreProjectEnvIfMissing(dir, CTX);
      expect(fs.readdirSync(dir)).toEqual(['.env']);
    });
  });
});
