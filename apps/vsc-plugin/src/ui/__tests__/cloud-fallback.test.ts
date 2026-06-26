import { describe, it, expect } from 'vitest';
import { buildCloudFallbackMessage } from '../cloud-fallback';

describe('buildCloudFallbackMessage', () => {
  it('includes the repo + branch line when a repo is known', () => {
    const m = buildCloudFallbackMessage({ repo: { owner: 'edgar-durand', repo: 'pdl' }, branch: 'main' });
    expect(m.repoLine).toBe('edgar-durand/pdl · main');
    expect(m.steps.length).toBeGreaterThanOrEqual(3);
    expect(m.title.toLowerCase()).toContain('reach');
    expect(m.learnMoreUrl).toBe('https://www.codeagent-mobile.com/docs/network');
  });
  it('omits the branch suffix when branch is unknown', () => {
    const m = buildCloudFallbackMessage({ repo: { owner: 'o', repo: 'r' }, branch: null });
    expect(m.repoLine).toBe('o/r');
  });
  it('repoLine is null and steps stay generic when there is no repo', () => {
    const m = buildCloudFallbackMessage({ repo: null, branch: null });
    expect(m.repoLine).toBeNull();
    expect(m.steps.length).toBeGreaterThanOrEqual(3);
  });
});
