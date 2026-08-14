import { describe, it, expect } from 'vitest';
import type { AgentId } from '../src/agents/types';
import { AGENT_REGISTRY } from '../src/agents/registry';
import {
  INSTALL_SNIPPETS,
  installableAgentIds,
  isNoopInstallSnippet,
} from '../src/agents/install-snippets';

const entries = Object.entries(INSTALL_SNIPPETS) as [AgentId, string][];

/**
 * Credential-substitution variables that must NEVER appear in an install
 * snippet. The auth half of each backend `ProvisioningStrategy`
 * (`getAuthSnippet`) is deliberately NOT mirrored into `@codeam/shared` — this
 * package is bundled into the CLI and the VS Code extension, so a token/key
 * placeholder leaking in here would put a credential-shaped template on every
 * user's disk.
 */
const CREDENTIAL_WORD_RE = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|API_?KEY|AUTH)/i;

describe('INSTALL_SNIPPETS', () => {
  it('has at least the installable agents the product ships', () => {
    for (const id of ['codex', 'gemini', 'kimi', 'cursor', 'opencode'] as AgentId[]) {
      expect(INSTALL_SNIPPETS[id], `missing install snippet for ${id}`).toBeTruthy();
    }
  });

  it('omits claude (its binary ships with the Agent SDK, not a separate installer)', () => {
    expect(INSTALL_SNIPPETS.claude).toBeUndefined();
  });

  it('only keys agents that exist in the registry', () => {
    for (const [id] of entries) {
      expect(AGENT_REGISTRY[id], `${id} is not a known agent`).toBeDefined();
    }
  });

  it.each(entries)('%s snippet is non-empty', (_id, snippet) => {
    expect(typeof snippet).toBe('string');
    expect(snippet.trim().length).toBeGreaterThan(0);
  });

  it.each(entries)('%s snippet contains no credential substitution vars', (id, snippet) => {
    // Grep-style: no `$FOO_TOKEN`, `${FOO_KEY}`, `FOO_SECRET=`, `--api-key`, …
    const varRefs = snippet.match(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g) ?? [];
    for (const ref of varRefs) {
      expect(
        CREDENTIAL_WORD_RE.test(ref),
        `${id} snippet references a credential-shaped variable: ${ref}`,
      ).toBe(false);
    }
    // Also catch bare assignments / flags that would carry a secret.
    const assignments = snippet.match(/\b[A-Z][A-Z0-9_]*(?==)/g) ?? [];
    for (const name of assignments) {
      expect(
        CREDENTIAL_WORD_RE.test(name),
        `${id} snippet assigns a credential-shaped variable: ${name}`,
      ).toBe(false);
    }
    expect(
      /--(api-?key|token|secret|password)\b/i.test(snippet),
      `${id} snippet passes a credential on argv`,
    ).toBe(false);
  });

  it.each(entries)('%s snippet performs no auth/login step', (id, snippet) => {
    expect(
      /\b(login|setup-token|auth\s+login)\b/i.test(snippet),
      `${id} snippet authenticates`,
    ).toBe(false);
  });

  it('every installable snippet is command -v guarded (idempotent re-run)', () => {
    for (const id of installableAgentIds()) {
      const snippet = INSTALL_SNIPPETS[id] ?? '';
      expect(snippet, `${id} snippet is not command -v guarded`).toMatch(/command -v/);
    }
  });
});

describe('isNoopInstallSnippet / installableAgentIds', () => {
  it('classifies the coderabbit credential-only marker as a no-op', () => {
    expect(isNoopInstallSnippet(INSTALL_SNIPPETS.coderabbit)).toBe(true);
  });

  it('classifies real installers as non-no-op', () => {
    expect(isNoopInstallSnippet(INSTALL_SNIPPETS.codex)).toBe(false);
    expect(isNoopInstallSnippet(INSTALL_SNIPPETS.kimi)).toBe(false);
  });

  it('treats a missing snippet as a no-op', () => {
    expect(isNoopInstallSnippet(undefined)).toBe(true);
  });

  it('installableAgentIds excludes coderabbit but includes the real installers', () => {
    const ids = installableAgentIds();
    expect(ids).not.toContain('coderabbit');
    expect(ids).toEqual(expect.arrayContaining(['codex', 'gemini', 'kimi', 'cursor', 'opencode']));
  });
});
