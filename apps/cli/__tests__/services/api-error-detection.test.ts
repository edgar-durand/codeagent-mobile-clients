import { describe, it, expect } from 'vitest';
import { extractApiErrorMessage } from '../../src/services/output.service';

describe('extractApiErrorMessage', () => {
  // Real PTY captures from production codespace logs. Each block
  // mirrors what `~/.codeam.log` showed when claude refused to
  // generate. Patterns must match these byte-for-byte (after ANSI
  // strip) or the mobile chat looks frozen for no reason.

  it('detects "Credit balance too low" on a single line', () => {
    const text = '└ Credit balance too low · Add funds: https://platform.claude.com/settings/billing';
    const msg = extractApiErrorMessage(text);
    expect(msg).toBe('Credit balance too low · Add funds: https://platform.claude.com/settings/billing');
  });

  it('detects credit balance even with the spinner header above it', () => {
    const text = [
      '✳ Accomplishing…',
      '└ Credit balance too low · Add funds: https://platform.claude.com/settings/billing',
      '✶ Baked for 0s',
    ].join('\n');
    expect(extractApiErrorMessage(text)).toMatch(/Credit balance too low/);
  });

  it('detects a generic "API Error: …" envelope', () => {
    const text = '└ API Error: 529 overloaded_error – please retry shortly';
    expect(extractApiErrorMessage(text)).toBe(
      'API Error: 529 overloaded_error – please retry shortly',
    );
  });

  it('detects quota-exceeded variants', () => {
    expect(extractApiErrorMessage('└ Quota exceeded for project foo')).toMatch(/quota/i);
    expect(extractApiErrorMessage('Insufficient credits to continue')).toMatch(/insufficient/i);
  });

  it('detects auth failures', () => {
    expect(extractApiErrorMessage('Authentication failed: invalid api key')).toMatch(/authentication failed/i);
    expect(extractApiErrorMessage('Unauthorized — please re-login')).toMatch(/unauthorized/i);
  });

  it('returns null on normal Claude output (no false positives)', () => {
    const text = [
      '● Hello! How can I help you today?',
      'I can run code, edit files, and answer questions.',
    ].join('\n');
    expect(extractApiErrorMessage(text)).toBeNull();
  });

  it('returns null on tool-result lines that are not errors', () => {
    expect(extractApiErrorMessage('└ Read /workspaces/foo/bar.ts (read 42 lines)')).toBeNull();
    expect(extractApiErrorMessage('└ Bash: npm install (exit 0)')).toBeNull();
    // "thought for 12s" is a thinking indicator, not an error.
    expect(extractApiErrorMessage('thought for 12s')).toBeNull();
  });

  it('does not match the word "credit" inside non-error content', () => {
    // The substring "Credit" alone must NOT trigger — only the
    // specific "Credit balance too low" phrase. Otherwise we'd flag
    // any line where Claude mentions credit in conversation.
    expect(extractApiErrorMessage('You can credit the user back via Stripe')).toBeNull();
  });

  it('collapses repeated whitespace in the extracted message', () => {
    const text = '└ Credit balance too low    ·    Add funds';
    expect(extractApiErrorMessage(text)).toBe('Credit balance too low · Add funds');
  });
});
