/**
 * TDD proof for the self-hosted Claude credential provisioning fix.
 *
 * THE BUG: `codeam link claude` produces a bare setup-token (`sk-ant-oat01-…`).
 * The backend stores it as `{ kind: 'oauth_token', value: 'sk-ant-oat01-...' }`.
 * Previously `claudeProvisioner.write` wrote `auth.value` verbatim to
 * `~/.claude/.credentials.json`. A bare token is NOT JSON — this creates an
 * invalid `.credentials.json` → Claude cannot authenticate → 401.
 *
 * THE FIX: discriminate on whether `auth.value.trim()` starts with `{`:
 *   - Bare setup-token (no `{`): return `{ CLAUDE_CODE_OAUTH_TOKEN: value }`,
 *     do NOT write `.credentials.json` (env var takes precedence, matches
 *     `codeam link claude` printed instructions).
 *   - JSON blob (starts with `{`): write `.credentials.json` verbatim (existing
 *     behaviour for the interactive-login flow), return `{}`.
 *
 * In both cases, `~/.claude.json` (onboarding-skip) is written as before.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { provisionAgentCredentials } from '../../src/commands/host/agent-provisioning';

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-provision-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('provisionAgentCredentials — claude_code / oauth_token', () => {
  it('bare setup-token: returns CLAUDE_CODE_OAUTH_TOKEN env var, does NOT write .credentials.json', () => {
    const env = provisionAgentCredentials(
      'claude_code',
      { kind: 'oauth_token', value: 'sk-ant-oat01-ABC' },
      tmpHome,
    );

    // Env var carries the token — bare tokens are not valid JSON.
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-ABC' });

    // No malformed .credentials.json written.
    const credentialsJsonPath = path.join(tmpHome, '.claude', '.credentials.json');
    expect(fs.existsSync(credentialsJsonPath)).toBe(false);

    // Onboarding-skip file is still created.
    const claudeJsonPath = path.join(tmpHome, '.claude.json');
    expect(fs.existsSync(claudeJsonPath)).toBe(true);
  });

  it('JSON blob: writes .credentials.json verbatim, does NOT include CLAUDE_CODE_OAUTH_TOKEN in env', () => {
    const blobValue = '{"claudeAiOauth":{"accessToken":"x"}}';
    const env = provisionAgentCredentials(
      'claude_code',
      { kind: 'oauth_token', value: blobValue },
      tmpHome,
    );

    // .credentials.json holds the blob exactly as provided.
    const credentialsJsonPath = path.join(tmpHome, '.claude', '.credentials.json');
    expect(fs.existsSync(credentialsJsonPath)).toBe(true);
    expect(fs.readFileSync(credentialsJsonPath, 'utf8')).toBe(blobValue);

    // Env does not expose the token — it lives on disk.
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');

    // Onboarding-skip file is still created.
    const claudeJsonPath = path.join(tmpHome, '.claude.json');
    expect(fs.existsSync(claudeJsonPath)).toBe(true);
  });
});

describe('provisionAgentCredentials — claude_code / api_key (unchanged path)', () => {
  it('returns ANTHROPIC_API_KEY env var and does NOT write .credentials.json', () => {
    const env = provisionAgentCredentials(
      'claude_code',
      { kind: 'api_key', value: 'sk-ant-api-test' },
      tmpHome,
    );

    expect(env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-api-test' });

    const credentialsJsonPath = path.join(tmpHome, '.claude', '.credentials.json');
    expect(fs.existsSync(credentialsJsonPath)).toBe(false);
  });
});

describe('provisionAgentCredentials — mutually-exclusive cleanup (authType change)', () => {
  it('claude: switching to a setup-token removes a stale .credentials.json so it cannot shadow the env token', () => {
    const credPath = path.join(tmpHome, '.claude', '.credentials.json');
    // Pre-seed a stale OAuth blob from a prior deploy.
    fs.mkdirSync(path.dirname(credPath), { recursive: true });
    fs.writeFileSync(credPath, '{"claudeAiOauth":{"accessToken":"OLD"}}');
    const env = provisionAgentCredentials('claude_code', { kind: 'oauth_token', value: 'sk-ant-oat01-NEW' }, tmpHome);
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-NEW' });
    expect(fs.existsSync(credPath)).toBe(false); // stale file gone
  });

  it('claude: switching to api_key removes a stale .credentials.json', () => {
    const credPath = path.join(tmpHome, '.claude', '.credentials.json');
    fs.mkdirSync(path.dirname(credPath), { recursive: true });
    fs.writeFileSync(credPath, '{"claudeAiOauth":{"accessToken":"OLD"}}');
    provisionAgentCredentials('claude_code', { kind: 'api_key', value: 'sk-ant-api-NEW' }, tmpHome);
    expect(fs.existsSync(credPath)).toBe(false);
  });
});

describe('provisionAgentCredentials — codex', () => {
  it('oauth_token: writes ~/.codex/auth.json verbatim, no env', () => {
    const blob = '{"OPENAI_API_KEY":null,"auth_mode":"chatgpt","tokens":{"access_token":"a","refresh_token":"r","id_token":"i","account_id":"acct"}}';
    const env = provisionAgentCredentials('codex', { kind: 'oauth_token', value: blob }, tmpHome);
    const authJson = path.join(tmpHome, '.codex', 'auth.json');
    expect(fs.readFileSync(authJson, 'utf8')).toBe(blob);
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('api_key: returns OPENAI_API_KEY and removes a stale auth.json (so it cannot shadow the key)', () => {
    const authJson = path.join(tmpHome, '.codex', 'auth.json');
    fs.mkdirSync(path.dirname(authJson), { recursive: true });
    fs.writeFileSync(authJson, '{"auth_mode":"chatgpt","tokens":{"access_token":"OLD"}}');
    const env = provisionAgentCredentials('codex', { kind: 'api_key', value: 'sk-openai-NEW' }, tmpHome);
    expect(env).toEqual({ OPENAI_API_KEY: 'sk-openai-NEW' });
    expect(fs.existsSync(authJson)).toBe(false);
  });
});
