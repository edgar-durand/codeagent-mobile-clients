import { describe, it, expect } from 'vitest';
import type { AgentId, AgentAuth, NormalizedMessage } from '../src/agents/types';
import { AGENT_REGISTRY, getEnabledAgents, getAgent } from '../src/agents/registry';

describe('agent types', () => {
  it('AgentId accepts the three known agents', () => {
    const ids: AgentId[] = ['claude', 'codex', 'copilot'];
    expect(ids.length).toBe(3);
  });

  it('AgentAuth structurally matches kind+value', () => {
    const a: AgentAuth = { kind: 'api_key', value: 'sk-test' };
    expect(a.kind).toBe('api_key');
    expect(a.value).toBe('sk-test');
  });

  it('NormalizedMessage has required fields', () => {
    const m: NormalizedMessage = {
      id: 'm1',
      role: 'user',
      text: 'hi',
      timestamp: '2026-05-13T00:00:00Z',
    };
    expect(m.id).toBe('m1');
  });
});

describe('AGENT_REGISTRY', () => {
  it('has entries for claude, codex, copilot', () => {
    expect(AGENT_REGISTRY.claude).toBeDefined();
    expect(AGENT_REGISTRY.codex).toBeDefined();
    expect(AGENT_REGISTRY.copilot).toBeDefined();
  });

  it('claude is enabled in Phase 1', () => {
    expect(AGENT_REGISTRY.claude.enabled).toBe(true);
  });

  it('all terminal agents are enabled; copilot still disabled (no runtime builder)', () => {
    expect(AGENT_REGISTRY.claude.enabled).toBe(true);
    expect(AGENT_REGISTRY.codex.enabled).toBe(true);
    expect(AGENT_REGISTRY.cursor.enabled).toBe(true);
    expect(AGENT_REGISTRY.coderabbit.enabled).toBe(true);
    expect(AGENT_REGISTRY.aider.enabled).toBe(true);
    expect(AGENT_REGISTRY.copilot.enabled).toBe(false);
  });

  it('getEnabledAgents returns only enabled ones', () => {
    const enabled = getEnabledAgents();
    expect(enabled.map(a => a.id).sort()).toEqual([
      'aider',
      'claude',
      'coderabbit',
      'codex',
      'cursor',
      'gemini',
      'kimi',
      'opencode',
    ]);
  });

  it('getAgent throws on unknown id', () => {
    expect(() => getAgent('zzz' as any)).toThrow();
  });

  it('every agent declares its preferredAuthKind in supportedAuthKinds', () => {
    for (const meta of Object.values(AGENT_REGISTRY)) {
      expect(meta.supportedAuthKinds).toContain(meta.preferredAuthKind);
    }
  });
});

/**
 * Gemini CLI — API key only, since Google retired the free/Pro/Ultra service.
 *
 * On **2026-06-18** Google stopped Gemini CLI (and the Gemini Code Assist IDE
 * extensions) serving requests for AI Pro, AI Ultra and free users, as part of
 * the move to Antigravity CLI. Its announcement is explicit about what lives
 * on: *"Gemini CLI will remain accessible via paid Gemini and Gemini
 * Enterprise Agent Platform API keys."*
 *
 * The package itself is NOT deprecated — `@google/gemini-cli` still ships
 * weekly — so the agent stays. What must go is the OAuth door: it captures a
 * `~/.gemini/oauth_creds.json` from a consumer Google account, which is
 * precisely the tier that no longer serves requests.
 *
 * We had `preferredAuthKind: 'oauth_token'`, i.e. we RECOMMENDED the dead path
 * first. Prod on 2026-09-15: 46 of 63 Gemini links were OAuth, 19 of them made
 * after 2026-09-01 and the newest that same day — three months of sending
 * people through a bricked door.
 *
 * ⚠️ Antigravity CLI is NOT a drop-in replacement for us: it has no official
 * ACP mode (google-antigravity/antigravity-cli#31, still open, 192 comments,
 * zero `acp` hits in the repo as of 2026-09-15) and every third-party adapter
 * warns that driving `agy` that way matches what Google's FAQ calls a ToS
 * violation, risking the USER's account. Our whole Gemini path is ACP. Revisit
 * only when that issue ships.
 */
describe('gemini: the retired OAuth tier is not offered', () => {
  it('accepts an API key and nothing else', () => {
    expect(AGENT_REGISTRY.gemini.supportedAuthKinds).toEqual(['api_key']);
  });

  it('prefers the api key — we must not recommend the dead path', () => {
    expect(AGENT_REGISTRY.gemini.preferredAuthKind).toBe('api_key');
  });

  it('does not offer oauth_token at all', () => {
    expect(AGENT_REGISTRY.gemini.supportedAuthKinds).not.toContain('oauth_token');
  });

  it('stays enabled — the CLI itself is alive on paid keys', () => {
    expect(AGENT_REGISTRY.gemini.enabled).toBe(true);
  });
});
