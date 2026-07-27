import { describe, it, expect } from 'vitest';
import {
  AGENT_REGISTRY,
  LINKED_AGENT_IDS,
  PUBLIC_TO_INTERNAL,
  INTERNAL_TO_PUBLIC,
  HOUSE_AGENT_ID,
  isLinkedAgentId,
  publicToInternal,
  internalToPublic,
  normalizeAgentId,
  headroomKindFor,
  isHeadroomWrappable,
  TERMINAL_AGENT_PREFIX,
} from '../src/agents';
import type { AgentId } from '../src/agents';

describe('LINKED_AGENT_IDS / PUBLIC_TO_INTERNAL', () => {
  it('lists every public id incl. the house agent', () => {
    expect(LINKED_AGENT_IDS).toEqual([
      'claude_code',
      'codex',
      'cursor',
      'aider',
      'coderabbit',
      'gemini',
      'kimi',
      'openrouter',
      'opencode',
      'house-codeagent-cloud',
    ]);
    expect(isLinkedAgentId(HOUSE_AGENT_ID)).toBe(true);
    expect(isLinkedAgentId('claude')).toBe(false); // internal id, not public
  });

  it('maps the backend LinkedAgentId space (agent-map.ts values)', () => {
    expect(publicToInternal('claude_code')).toBe('claude');
    expect(publicToInternal('codex')).toBe('codex');
    expect(publicToInternal('cursor')).toBe('cursor');
    expect(publicToInternal('aider')).toBe('aider');
    expect(publicToInternal('coderabbit')).toBe('coderabbit');
    expect(publicToInternal('gemini')).toBe('gemini');
    // The house agent runs Claude Code under the hood.
    expect(publicToInternal(HOUSE_AGENT_ID)).toBe('claude');
    // OpenRouter also runs Claude Code under the hood (pointed at the user's
    // gateway) — same lossy-to-'claude' mapping as the house agent.
    expect(publicToInternal('openrouter')).toBe('claude');
  });

  it('additionally accepts the CLI-side extras (agent-provisioning.ts asymmetry)', () => {
    // Self-hosted deploy payloads historically carried already-internal ids.
    expect(publicToInternal('claude')).toBe('claude');
    expect(publicToInternal('copilot')).toBe('copilot');
    // But neither is a public LinkedAgentId.
    expect(isLinkedAgentId('copilot')).toBe(false);
  });

  it('rejects unknown ids with null (never a fallback)', () => {
    expect(publicToInternal('gibberish')).toBeNull();
    expect(publicToInternal('')).toBeNull();
  });

  it('INTERNAL_TO_PUBLIC round-trips every non-house public id', () => {
    for (const publicId of LINKED_AGENT_IDS) {
      // house + openrouter both map to internal 'claude' (lossy on purpose) —
      // internalToPublic('claude') is 'claude_code', never these.
      if (publicId === HOUSE_AGENT_ID || publicId === 'openrouter') continue;
      const internal = PUBLIC_TO_INTERNAL[publicId];
      expect(internalToPublic(internal)).toBe(publicId);
    }
    // copilot has no public id; claude maps back to claude_code (lossy on
    // purpose — never the house agent).
    expect(internalToPublic('copilot')).toBeNull();
    expect(internalToPublic('claude')).toBe('claude_code');
    expect(INTERNAL_TO_PUBLIC.claude).toBe('claude_code');
  });
});

describe('normalizeAgentId — the ONE alias normalizer', () => {
  it('passes registry ids through', () => {
    for (const id of Object.keys(AGENT_REGISTRY) as AgentId[]) {
      expect(normalizeAgentId(id)).toBe(id);
    }
  });

  it('normalizes the public claude_code alias (handlers.ts sites)', () => {
    expect(normalizeAgentId('claude_code')).toBe('claude');
    expect(normalizeAgentId('claude-code')).toBe('claude');
  });

  it('is case/whitespace tolerant', () => {
    expect(normalizeAgentId('  Claude_Code ')).toBe('claude');
    expect(normalizeAgentId('CURSOR')).toBe('cursor');
  });

  it('normalizes every marketplace extension id (vsc-plugin alias set)', () => {
    const claudeAliases = [
      'anthropic.claude-code',
      'anthropics.claude',
      'anthropic.claude-ce',
      'anthropic.claude',
      'com.anthropic.claudecode',
      'com.anthropic.claude',
    ];
    for (const alias of claudeAliases) {
      expect(normalizeAgentId(alias)).toBe('claude');
    }
    expect(normalizeAgentId('openai.chatgpt')).toBe('codex');
    expect(normalizeAgentId('coderabbitai.coderabbit-vscode')).toBe('coderabbit');
  });

  it('strips the __terminal__: prefix, then resolves', () => {
    expect(normalizeAgentId(`${TERMINAL_AGENT_PREFIX}claude`)).toBe('claude');
    expect(normalizeAgentId('__terminal__:claude_code')).toBe('claude');
    expect(normalizeAgentId('__terminal__:openai.chatgpt')).toBe('codex');
  });

  it('does NOT gate on enabled — copilot (disabled) still normalizes', () => {
    // Availability is the caller's concern (see vsc-plugin normalizeCliAgentId).
    expect(normalizeAgentId('copilot')).toBe('copilot');
  });

  it('does NOT map the house agent (runtime substitution, not an alias)', () => {
    expect(normalizeAgentId(HOUSE_AGENT_ID)).toBeNull();
  });

  it('returns null for unknown / empty input — no fallback', () => {
    expect(normalizeAgentId('gibberish')).toBeNull();
    expect(normalizeAgentId('')).toBeNull();
    expect(normalizeAgentId('   ')).toBeNull();
  });
});

describe('headroomKindFor — registry-derived, NEVER a claude fallback', () => {
  it('maps the wrappable agents across both id spaces (separator/case tolerant)', () => {
    expect(headroomKindFor('claude')).toBe('claude');
    expect(headroomKindFor('claude_code')).toBe('claude');
    expect(headroomKindFor('Claude-Code')).toBe('claude');
    expect(headroomKindFor('codex')).toBe('codex');
    expect(headroomKindFor('codex_cli')).toBe('codex');
    expect(headroomKindFor('copilot')).toBe('copilot');
    expect(headroomKindFor('copilot-cli')).toBe('copilot');
  });

  it('returns null for the non-wrappable agents (they run native)', () => {
    // A claude fallback here is how the 2026-06 Cursor mislaunch happened:
    // cursor slipped through, defaulted to claude, and `headroom wrap claude`
    // launched Claude Code instead of cursor-agent.
    expect(headroomKindFor('cursor')).toBeNull();
    expect(headroomKindFor('gemini')).toBeNull();
    expect(headroomKindFor('aider')).toBeNull();
    expect(headroomKindFor('coderabbit')).toBeNull();
  });

  it('returns null for unknown / empty input', () => {
    expect(headroomKindFor('something_else')).toBeNull();
    expect(headroomKindFor('')).toBeNull();
  });

  it('agrees with the registry flags (headroomKind ⇔ headroomWrappable)', () => {
    for (const meta of Object.values(AGENT_REGISTRY)) {
      expect(meta.headroomKind !== undefined).toBe(meta.headroomWrappable);
      expect(isHeadroomWrappable(meta.id)).toBe(meta.headroomWrappable);
      if (meta.headroomKind) expect(headroomKindFor(meta.id)).toBe(meta.headroomKind);
    }
  });
});

describe('capability flags (registry)', () => {
  it('headroom-wrappable = claude/codex/copilot exactly (api-v2 + CLI gates)', () => {
    const wrappable = Object.values(AGENT_REGISTRY)
      .filter((m) => m.headroomWrappable)
      .map((m) => m.id)
      .sort();
    expect(wrappable).toEqual(['claude', 'codex', 'copilot']);
  });

  it('acp = claude/codex/cursor/gemini/kimi exactly (adapters.ts REGISTRY)', () => {
    const acp = Object.values(AGENT_REGISTRY)
      .filter((m) => m.acp)
      .map((m) => m.id)
      .sort();
    expect(acp).toEqual(['claude', 'codex', 'cursor', 'gemini', 'kimi', 'opencode']);
  });

  it('device-flow agents mirror the mobile agentCatalog (codex shows userCode, cursor must not)', () => {
    expect(AGENT_REGISTRY.codex.deviceFlow).toBe(true);
    expect(AGENT_REGISTRY.codex.showsUserCode).toBe(true);
    expect(AGENT_REGISTRY.cursor.deviceFlow).toBe(true);
    // Cursor's userCode is the secret PKCE verifier — rendering it leaks it.
    expect(AGENT_REGISTRY.cursor.showsUserCode).toBe(false);
    expect(AGENT_REGISTRY.claude.deviceFlow).toBeUndefined();
    expect(AGENT_REGISTRY.gemini.deviceFlow).toBeUndefined();
  });
});
