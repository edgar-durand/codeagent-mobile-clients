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
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { provisionAgentCredentials } from '../../src/commands/host/agent-provisioning';

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

type AcpOutcome =
  | { kind: 'streamed'; stopReason?: string }
  | { kind: 'auth_error'; code: number; message: string }
  | { kind: 'timeout' };

/**
 * Minimal ACP client: initialize → session/new → session/prompt over stdio
 * JSON-RPC. Resolves as soon as the prompt streams a chunk / resolves, or as
 * soon as auth fails, or on timeout.
 */
function runAcpPrompt(kimiBin: string, home: string, cwd: string): Promise<AcpOutcome> {
  return new Promise((resolve) => {
    const child = spawn(kimiBin, ['acp'], {
      cwd,
      env: { ...process.env, HOME: home, KIMI_CODE_HOME: path.join(home, '.kimi-code') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let streamedChunk = false;
    let settled = false;
    const done = (o: AcpOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* noop */
      }
      resolve(o);
    };
    const send = (o: unknown): void => {
      child.stdin.write(`${JSON.stringify(o)}\n`);
    };
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m: {
          id?: number;
          method?: string;
          result?: { sessionId?: string; stopReason?: string };
          error?: { code: number; message: string };
          params?: { update?: { sessionUpdate?: string } };
        };
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1 && m.result) {
          send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } });
        }
        if (m.id === 2 && m.result?.sessionId) {
          send({
            jsonrpc: '2.0',
            id: 3,
            method: 'session/prompt',
            params: { sessionId: m.result.sessionId, prompt: [{ type: 'text', text: 'reply with just OK' }] },
          });
        }
        if (m.method === 'session/update' && m.params?.update?.sessionUpdate === 'agent_message_chunk') {
          streamedChunk = true;
        }
        if ((m.id === 2 || m.id === 3) && m.error) {
          done({ kind: 'auth_error', code: m.error.code, message: m.error.message });
        }
        if (m.id === 3 && m.result) {
          done({ kind: 'streamed', stopReason: m.result.stopReason });
        }
      }
    });
    child.on('error', () => done({ kind: 'timeout' }));
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    const timer = setTimeout(() => {
      done(streamedChunk ? { kind: 'streamed' } : { kind: 'timeout' });
    }, 45_000);
  });
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
