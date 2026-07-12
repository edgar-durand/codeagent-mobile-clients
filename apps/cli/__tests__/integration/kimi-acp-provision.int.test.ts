/**
 * Kimi ACP auth — REAL `kimi acp` integration test (the regression reproducer).
 *
 * This is NOT a unit test. It exercises the EXACT provisioning artifacts the fix
 * ships (`provisionAgentCredentials('kimi', …)` → credential + config.toml) against
 * a REAL `kimi` binary over ACP, and asserts the auth BEHAVIOR that the unit tests
 * (which only check "the file was written") cannot:
 *
 *   POSITIVE (the fix): credential at ~/.kimi-code/credentials/kimi-code.json
 *     → `kimi acp` initialize + session/new + session/prompt STREAMS an
 *       `agent_message_chunk` / resolves with a stopReason, NO `-32000
 *       Authentication required`.
 *
 *   NEGATIVE (the misdiagnosed "fix" — credential in a bare oauth/kimi-code slot,
 *     NOT credentials/kimi-code.json): `session/new` → `-32000 Authentication
 *     required`. This is the exact failure the 2026-07-11 incident hit; it proves
 *     the test reproduces the class AND that the credentials/ slot is load-bearing.
 *
 * ── Root cause it guards ──────────────────────────────────────────────────────
 * The config's oauth ref `storage="file" key="oauth/kimi-code"` does NOT resolve to
 * ~/.kimi-code/oauth/. The 0.23.5 binary's `resolveKimiTokenStorageName` STRIPS the
 * `oauth/` prefix → storage name `kimi-code`, and `FileTokenStorage` reads
 * `<name>.json` from the credentials dir → `kimi acp` reads/refreshes
 * ~/.kimi-code/credentials/kimi-code.json for auth (strace-confirmed live).
 *
 * ── Gating ────────────────────────────────────────────────────────────────────
 * Skipped UNLESS ALL of:
 *   - RUN_KIMI_INT=1
 *   - a real `kimi` binary is resolvable (PATH or ~/.kimi-code/bin/kimi)
 *   - KIMI_TEST_CREDENTIAL_JSON holds a LIVE credential blob
 *     ({access_token,refresh_token,expires_at,scope,token_type}). NEVER hardcode a
 *     token — the suite reads it from the env and skips cleanly when absent.
 * The default `npm run test` NEVER needs a kimi binary, network, or a credential.
 *
 *   RUN_KIMI_INT=1 KIMI_TEST_CREDENTIAL_JSON="$(cat ~/.kimi-code/credentials/kimi-code.json)" \
 *     npx vitest run kimi-acp-provision
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { provisionAgentCredentials } from '../../src/commands/host/agent-provisioning';
import { acpSmokeDrive, type AcpOutcome } from '../fixtures/acp-smoke-driver';

const RUN_KIMI_INT = process.env.RUN_KIMI_INT === '1';
const CREDENTIAL = process.env.KIMI_TEST_CREDENTIAL_JSON ?? '';

function resolveKimiBinary(): string | null {
  const home = os.homedir();
  const bundled = path.join(home, '.kimi-code', 'bin', 'kimi');
  if (fs.existsSync(bundled)) return bundled;
  try {
    const p = execFileSync('bash', ['-lc', 'command -v kimi'], { encoding: 'utf8' }).trim();
    return p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

const KIMI_BIN = RUN_KIMI_INT ? resolveKimiBinary() : null;
const ready = RUN_KIMI_INT && KIMI_BIN !== null && CREDENTIAL.trim().length > 0;

if (!RUN_KIMI_INT) {
  // eslint-disable-next-line no-console
  console.log('[kimi-acp-provision] SKIPPED — set RUN_KIMI_INT=1 (+ a real kimi binary + KIMI_TEST_CREDENTIAL_JSON) to run.');
} else if (KIMI_BIN === null) {
  // eslint-disable-next-line no-console
  console.log('[kimi-acp-provision] SKIPPED — RUN_KIMI_INT=1 but no `kimi` binary resolvable (PATH / ~/.kimi-code/bin).');
} else if (CREDENTIAL.trim().length === 0) {
  // eslint-disable-next-line no-console
  console.log('[kimi-acp-provision] SKIPPED — RUN_KIMI_INT=1 but KIMI_TEST_CREDENTIAL_JSON is empty.');
}

/**
 * Drive the kimi ACP handshake via the SHARED smoke driver — the exact same
 * `initialize → session/new → session/prompt` logic every ACP-provision test
 * uses (see `../fixtures/acp-smoke-driver.ts`). We only shape kimi's spawn env
 * (isolated HOME + KIMI_CODE_HOME) and return the terminal outcome.
 */
async function runAcpPrompt(kimiBin: string, home: string, cwd: string): Promise<AcpOutcome> {
  const { outcome } = await acpSmokeDrive({
    command: kimiBin,
    args: ['acp'],
    env: { ...process.env, HOME: home, KIMI_CODE_HOME: path.join(home, '.kimi-code') },
    cwd,
  });
  return outcome;
}

const MANAGED_CONFIG = `default_model = "kimi-k2"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"
oauthHost = "https://auth.kimi.com"

[models.kimi-k2]
provider = "managed:kimi-code"
model = "kimi-k2"
max_context_size = 262144
`;

// eslint-disable-next-line vitest/valid-describe-callback
(ready ? describe : describe.skip)('kimi ACP auth — real `kimi acp` against provisioned artifacts', () => {
  let home: string;
  let cwd: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-acp-int-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-acp-cwd-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('POSITIVE — provisioned credential (credentials/kimi-code.json) → session/prompt STREAMS, no -32000', async () => {
    // Exercise the SAME code the fix ships.
    provisionAgentCredentials('kimi', { kind: 'oauth_token', value: CREDENTIAL }, home);
    expect(fs.existsSync(path.join(home, '.kimi-code', 'credentials', 'kimi-code.json'))).toBe(true);

    const outcome = await runAcpPrompt(KIMI_BIN as string, home, cwd);
    // The bug was -32000 "Authentication required"; assert we did NOT hit it.
    expect(outcome.kind).not.toBe('auth_error');
    expect(outcome.kind).toBe('streamed');
  }, 60_000);

  it('NEGATIVE — credential in a bare oauth/kimi-code slot (misdiagnosed fix) → session/new -32000', async () => {
    // Reproduce the incident: config present, but the token is in the WRONG slot
    // (~/.kimi-code/oauth/kimi-code) that FileTokenStorage never reads.
    const kimiHome = path.join(home, '.kimi-code');
    fs.mkdirSync(path.join(kimiHome, 'oauth'), { recursive: true });
    fs.writeFileSync(path.join(kimiHome, 'oauth', 'kimi-code'), CREDENTIAL, { mode: 0o600 });
    fs.writeFileSync(path.join(kimiHome, 'config.toml'), MANAGED_CONFIG, { mode: 0o600 });
    // Ensure the correct slot is ABSENT so this is a true negative control.
    expect(fs.existsSync(path.join(kimiHome, 'credentials', 'kimi-code.json'))).toBe(false);

    const outcome = await runAcpPrompt(KIMI_BIN as string, home, cwd);
    expect(outcome.kind).toBe('auth_error');
    if (outcome.kind === 'auth_error') {
      expect(outcome.message).toMatch(/Authentication required/i);
    }
  }, 60_000);
});
