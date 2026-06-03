import { describe, expect, it } from 'vitest';
import {
  buildCodespaceUrl,
  isCodespaceSession,
} from '../../src/services/preview/codespace';

describe('buildCodespaceUrl', () => {
  it('constructs the forwarded port URL', () => {
    expect(buildCodespaceUrl('animated-dollop-abc', 3000)).toBe(
      'https://animated-dollop-abc-3000.app.github.dev',
    );
  });
});

describe('isCodespaceSession', () => {
  it('returns true when CODESPACE_NAME is set', () => {
    expect(isCodespaceSession({ CODESPACE_NAME: 'foo' })).toBe(true);
  });
  it('returns false otherwise', () => {
    expect(isCodespaceSession({})).toBe(false);
  });
});
