/**
 * codeagent-fyas item (3): the self-hosted / fleet-Box credential matrix.
 *
 * Every ENABLED agent in the shared registry can be deployed to a Box, and the
 * host-agent hands its sealed credential to `provisionAgentCredentials`. An
 * agent with no provisioner throws `UnsupportedAgentError` and the deploy
 * fails — prod Cloud Run logged 23 aider deploys failing exactly that way
 * ("Self-hosted provisioning is not implemented for agent "aider"",
 * 2026-09-10..2026-10-08). This walks the registry so a newly enabled agent
 * fails here instead of on a user's Box.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AGENT_REGISTRY, type AgentAuthKind } from '@codeam/shared';
import {
  UnsupportedAgentError,
  provisionAgentCredentials,
  toInternalAgentId,
} from '../../src/commands/host/agent-provisioning';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-prov-matrix-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** A credential value each provisioner accepts for `kind`. */
function sampleValue(agentId: string, kind: AgentAuthKind): string {
  if (kind === 'api_key') return 'sk-test-key';
  if (agentId === 'claude') return 'sk-ant-oat01-test';
  if (agentId === 'cursor') return JSON.stringify({ accessToken: 'a', refreshToken: 'r', userId: 'u' });
  if (agentId === 'codex') {
    return JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'x', access_token: 'a', refresh_token: 'r', account_id: 'acc' } });
  }
  return JSON.stringify({ access_token: 'a', refresh_token: 'r' });
}

/** The public id the backend sends for an internal agent id. */
function publicIdFor(internal: string): string {
  const publicId = internal === 'claude' ? 'claude_code' : internal;
  expect(toInternalAgentId(publicId), `no public id maps to ${internal}`).toBe(internal);
  return publicId;
}

const enabled = Object.values(AGENT_REGISTRY).filter((m) => m.enabled);

describe('provisionAgentCredentials — every enabled agent × auth kind is provisionable', () => {
  const rows = enabled.flatMap((m) =>
    m.supportedAuthKinds.map((kind) => [m.id, kind] as const),
  );

  it('covers the agents users can deploy today', () => {
    expect(enabled.map((m) => m.id)).toEqual(expect.arrayContaining(['claude', 'codex', 'aider', 'opencode']));
  });

  it.each(rows)('%s / %s does not throw UnsupportedAgentError', (agentId, kind) => {
    const publicId = publicIdFor(agentId);
    let err: unknown;
    try {
      provisionAgentCredentials(publicId, { kind, value: sampleValue(agentId, kind) }, home);
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeInstanceOf(UnsupportedAgentError);
  });
});

describe('provisionAgentCredentials — provider-key agents (aider, opencode)', () => {
  it.each([
    ['aider', 'sk-ant-api03-xyz', 'ANTHROPIC_API_KEY'],
    ['aider', 'AIzaSyXYZ', 'GEMINI_API_KEY'],
    ['aider', 'sk-proj-xyz', 'OPENAI_API_KEY'],
    ['opencode', 'sk-ant-api03-xyz', 'ANTHROPIC_API_KEY'],
    ['opencode', 'AIzaSyXYZ', 'GEMINI_API_KEY'],
    ['opencode', 'sk-proj-xyz', 'OPENAI_API_KEY'],
  ])('%s: key %s exports only %s and writes no files', (agent, key, envName) => {
    const env = provisionAgentCredentials(agent, { kind: 'api_key', value: `  ${key}\n` }, home);
    expect(env).toEqual({ [envName]: key });
    expect(fs.readdirSync(home)).toEqual([]);
  });
});

describe('provisionAgentCredentials — env var XOR login file per auth.kind', () => {
  const LOGIN_FILES: Record<string, string[]> = {
    gemini: ['.gemini/oauth_creds.json'],
    cursor: ['.config/cursor/auth.json'],
    kimi: ['.kimi/credentials/kimi-code.json', '.kimi-code/credentials/kimi-code.json'],
    coderabbit: ['.coderabbit/auth.json'],
  };

  it.each(Object.keys(LOGIN_FILES))('%s: api_key removes a stale login file; oauth_token writes it and exports nothing', (agent) => {
    const files = LOGIN_FILES[agent].map((f) => path.join(home, f));
    const oauth = provisionAgentCredentials(publicIdFor(agent), { kind: 'oauth_token', value: sampleValue(agent, 'oauth_token') }, home);
    expect(oauth).toEqual({});
    for (const f of files) expect(fs.existsSync(f), f).toBe(true);

    const apiKey = provisionAgentCredentials(publicIdFor(agent), { kind: 'api_key', value: 'sk-test-key' }, home);
    expect(Object.values(apiKey)).toContain('sk-test-key');
    for (const f of files) expect(fs.existsSync(f), f).toBe(false);
  });
});
