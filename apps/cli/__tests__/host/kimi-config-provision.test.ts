import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Assert kimi provisioning NEVER runs `kimi login`. Root-caused live on kimi
// 0.23.4: `kimi login` does NOT detect the on-disk credential — it starts the
// RFC 8628 device flow and ZEROES ~/.kimi-code/credentials/kimi-code.json, so
// (headless) it leaves the credential EMPTY → `kimi acp` "-32000 Authentication
// required". The written blob authenticates on its own. Mock spawnSync so a stray
// login would be caught.
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(() => ({ status: 0 })) };
});

import { spawnSync } from 'node:child_process';
import { provisionAgentCredentials } from '../../src/commands/host/agent-provisioning';

const spawnSyncMock = spawnSync as unknown as ReturnType<typeof vi.fn>;

let tmpHome: string;
beforeEach(() => {
  spawnSyncMock.mockClear();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-cfg-'));
});
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('kimi oauth_token provisioning — write the credential, NEVER run `kimi login`', () => {
  it('writes the credential blob to both locations and does NOT run `kimi login` (it wipes the credential)', () => {
    provisionAgentCredentials('kimi', { kind: 'oauth_token', value: '{"access_token":"x"}' }, tmpHome);

    // The credential blob is written to both locations kimi may read.
    expect(fs.existsSync(path.join(tmpHome, '.kimi', 'credentials', 'kimi-code.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.kimi-code', 'credentials', 'kimi-code.json'))).toBe(true);

    // `kimi login` must NEVER run — it would zero the just-written credential.
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('api_key path writes KIMI_API_KEY and runs nothing', () => {
    const env = provisionAgentCredentials('kimi', { kind: 'api_key', value: 'sk-kimi' }, tmpHome);
    expect(env).toEqual({ KIMI_API_KEY: 'sk-kimi' });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
