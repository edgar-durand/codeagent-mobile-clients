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

  it('writes the managed-provider config.toml so the injected credential resolves a model (kimi 0.23.5 fix)', () => {
    provisionAgentCredentials('kimi', { kind: 'oauth_token', value: '{"access_token":"x"}' }, tmpHome);

    const cfgPath = path.join(tmpHome, '.kimi-code', 'config.toml');
    expect(fs.existsSync(cfgPath)).toBe(true);
    const cfg = fs.readFileSync(cfgPath, 'utf8');
    // The managed provider + a resolvable default_model must be present — without
    // these kimi 0.23.5 authenticates but returns empty (No model configured).
    expect(cfg).toContain('default_model = "kimi-k2"');
    expect(cfg).toContain('[providers."managed:kimi-code"]');
    expect(cfg).toContain('base_url = "https://api.kimi.com/coding/v1"');
    expect(cfg).toContain('key = "oauth/kimi-code"');
    expect(cfg).toContain('[models.kimi-k2]');
    expect(cfg).toContain('max_context_size = 262144');

    // config write must not shell out to `kimi login` either.
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  // REGRESSION — ACP login-state slot (2026-07-11 "-32000 Authentication required"
  // ACP incident, live-verified on a real codespace). The config.toml fix made
  // HEADLESS work; the ACP failure was MISDIAGNOSED as "the credential belongs in an
  // oauth/ slot". It does NOT: the 0.23.5 binary's `resolveKimiTokenStorageName`
  // STRIPS the `oauth/` prefix from `key = "oauth/kimi-code"` → storage name
  // `kimi-code`, and `FileTokenStorage` reads `<name>.json` from the credentials dir,
  // so `kimi acp` reads/refreshes `~/.kimi-code/credentials/kimi-code.json`. Live
  // proof (isolated $KIMI_CODE_HOME): credential there → session/prompt STREAMS;
  // credential in a bare oauth/kimi-code slot → session/new → -32000. This asserts
  // the credential lands at the ACP login-state path and NOT the useless oauth/ slot.
  // Byte-consistent with the codespace test (api-v2 agent.spec.ts).
  it('oauth_token → credential lands at the ACP login-state slot ~/.kimi-code/credentials/kimi-code.json (NOT a bare oauth/ slot)', () => {
    const blob = JSON.stringify({
      access_token: 'x',
      refresh_token: 'rt',
      expires_at: 4102444800,
      scope: 'kimi-code',
      token_type: 'Bearer',
    });
    provisionAgentCredentials('kimi', { kind: 'oauth_token', value: blob }, tmpHome);
    // The load-bearing file `kimi acp`'s FileTokenStorage reads for key oauth/kimi-code.
    const acpSlot = path.join(tmpHome, '.kimi-code', 'credentials', 'kimi-code.json');
    expect(fs.existsSync(acpSlot)).toBe(true);
    expect(fs.readFileSync(acpSlot, 'utf8')).toBe(blob);
    // The misdiagnosed slot MUST NOT be where the credential lives — it is never read.
    expect(fs.existsSync(path.join(tmpHome, '.kimi-code', 'oauth', 'kimi-code'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.kimi-code', 'oauth', 'kimi-code.json'))).toBe(false);
  });

  it('api_key path does NOT write config.toml (KIMI_API_KEY needs no managed provider)', () => {
    provisionAgentCredentials('kimi', { kind: 'api_key', value: 'sk-kimi' }, tmpHome);
    expect(fs.existsSync(path.join(tmpHome, '.kimi-code', 'config.toml'))).toBe(false);
  });

  it('api_key path writes KIMI_API_KEY and runs nothing', () => {
    const env = provisionAgentCredentials('kimi', { kind: 'api_key', value: 'sk-kimi' }, tmpHome);
    expect(env).toEqual({ KIMI_API_KEY: 'sk-kimi' });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
