import { describe, it, expect } from 'vitest';
import { prefixForProjectKey } from '../../src/beads/project-prefix';

describe('prefixForProjectKey', () => {
  it('is stable for the same key', () => {
    expect(prefixForProjectKey('github.com/edgar-durand/codeagent-mobile')).toBe(
      prefixForProjectKey('github.com/edgar-durand/codeagent-mobile'),
    );
  });

  it('differs for different keys (hash suffix prevents collision)', () => {
    expect(prefixForProjectKey('github.com/x/repo')).not.toBe(
      prefixForProjectKey('github.com/y/repo'),
    );
  });

  it('is a valid SQL/bd database name (starts alpha, [a-z0-9_], bounded)', () => {
    expect(prefixForProjectKey('github.com/Edgar/Codeagent-Mobile.git')).toMatch(
      /^[a-z][a-z0-9_]{0,40}$/,
    );
  });

  it('path-hash fallback keys also produce valid prefixes', () => {
    expect(prefixForProjectKey('path:abc123def456')).toMatch(/^[a-z][a-z0-9_]{0,40}$/);
  });

  it('two repos with the same name (different org) get distinct prefixes', () => {
    expect(prefixForProjectKey('github.com/orgA/api')).not.toBe(
      prefixForProjectKey('github.com/orgB/api'),
    );
  });

  it('a leading non-alpha label still yields an alpha-leading prefix', () => {
    expect(prefixForProjectKey('github.com/acme/123-service')).toMatch(/^[a-z]/);
  });
});
