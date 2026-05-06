import { describe, it, expect } from 'vitest';
import { encodeCwd } from '../src/services/history.service';

/**
 * The CLI looks up Claude session JSONLs at
 * `~/.claude/projects/<encodeCwd(cwd)>/`. The encoding has to match
 * Claude Code's own scheme on every platform; previously the regex
 * only handled forward slashes, so on Windows every history-driven
 * feature silently no-op'd because the lookup path was invalid.
 */
describe('encodeCwd', () => {
  it('replaces forward slashes (POSIX path)', () => {
    expect(encodeCwd('/Users/edgar/foo')).toBe('-Users-edgar-foo');
  });

  it('replaces backslashes and drive-letter colon (Windows path)', () => {
    expect(encodeCwd('C:\\Users\\edgar\\foo')).toBe('C--Users-edgar-foo');
  });

  it('handles a Windows path with mixed separators', () => {
    expect(encodeCwd('C:\\Users/edgar\\foo')).toBe('C--Users-edgar-foo');
  });

  it('leaves a name with no separators untouched', () => {
    expect(encodeCwd('project')).toBe('project');
  });

  it('handles a UNC-style Windows path', () => {
    expect(encodeCwd('\\\\server\\share\\foo')).toBe('--server-share-foo');
  });
});
