import { describe, it, expect } from 'vitest';
import { extractSetupTokenFromOutput } from '../../src/agents/claude/link';

describe('extractSetupTokenFromOutput', () => {
  it('pulls the sk-ant-oat01 setup-token out of the CLI stdout', () => {
    const out = [
      '✓ Long-lived authentication token created successfully!',
      'Your OAuth token (valid for 1 year):',
      'sk-ant-oat01-AbC123_def-456GHI_jkl789-MNOpqr',
      "Store this token securely. You won't be able to see it again.",
    ].join('\n');
    expect(extractSetupTokenFromOutput(out)).toBe('sk-ant-oat01-AbC123_def-456GHI_jkl789-MNOpqr');
  });

  it('returns null when no token is present (user aborted / browser not finished)', () => {
    expect(extractSetupTokenFromOutput('Visit the URL to authorize…\n')).toBeNull();
  });

  it('ignores surrounding ANSI/whitespace and grabs only the token', () => {
    expect(extractSetupTokenFromOutput('  \x1b[33msk-ant-oat01-XYZ_001\x1b[0m  ')).toBe(
      'sk-ant-oat01-XYZ_001',
    );
  });
});
