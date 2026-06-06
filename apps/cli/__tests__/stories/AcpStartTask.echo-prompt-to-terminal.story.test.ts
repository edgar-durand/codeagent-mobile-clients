/**
 * Story — ACP runner echoes the mobile prompt to the user's terminal.
 *
 * Why this test exists
 * --------------------
 * QA Android #287: Nabeel sent a message from the mobile app while
 * the CLI was running in the VS Code terminal. The agent's reply
 * landed back on mobile, but the VS Code terminal showed nothing —
 * the user had no signal that ANY input had been received locally.
 *
 * Pre-ACP the legacy PTY pipeline injected the mobile prompt straight
 * into claude's stdin, so the terminal naturally echoed it. Under ACP
 * the prompt goes through the adapter's JSON-RPC connection and never
 * touches the terminal. This is technically correct but visually
 * silent — local observers (the dev sitting at the laptop) lose the
 * "something just happened" signal.
 *
 * Expected behaviour
 * ------------------
 * Whenever `start_task` arrives, the CLI prints a one-line breadcrumb
 * to stdout (or stderr — whatever stays visible after a `clack`
 * spinner closes):
 *
 *     › Mobile: <first 200 chars of the prompt>
 *
 * - Truncated past 200 chars + "…" so a giant paste doesn't flood the
 *   terminal.
 * - Mentions image attachments by count (no inline base64 of course)
 *   so the user knows the mobile sent images even if there's no text.
 * - Multi-line prompts collapse newlines to spaces so the line stays
 *   visually one breadcrumb.
 *
 * Strategy
 * --------
 * The contract is a pure formatter `formatPromptEchoLine(payload)`.
 * Wiring into the runner is a single `console.log` call site that
 * fires once per `start_task` ack — covered by separate integration
 * smoke.
 */
import { describe, it, expect } from 'vitest';
import { formatPromptEchoLine } from '../../src/agents/acp/promptEcho';

describe('story: ACP start_task / echo mobile prompt to terminal', () => {
  it('prefixes the prompt with the "Mobile:" tag', () => {
    expect(formatPromptEchoLine({ prompt: 'Hello' })).toContain('Mobile: Hello');
  });

  it('truncates prompts longer than 200 chars with an ellipsis', () => {
    const long = 'a'.repeat(500);
    const line = formatPromptEchoLine({ prompt: long });
    expect(line.length).toBeLessThanOrEqual(220); // tag + truncated body
    expect(line).toMatch(/…$/);
  });

  it('collapses newlines so the breadcrumb stays one visual line', () => {
    const multiline = 'line1\nline2\nline3';
    const line = formatPromptEchoLine({ prompt: multiline });
    expect(line).not.toContain('\n');
    expect(line).toContain('line1 line2 line3');
  });

  it('mentions image attachments by count when files are present', () => {
    const line = formatPromptEchoLine({
      prompt: 'Check this',
      files: [
        { filename: 'a.png', base64: 'iVBOR', mimeType: 'image/png' },
        { filename: 'b.jpg', base64: '/9j/', mimeType: 'image/jpeg' },
      ],
    });
    expect(line).toContain('Check this');
    expect(line).toMatch(/2 image/i);
  });

  it('handles attachments-only with no prompt by surfacing just the file count', () => {
    const line = formatPromptEchoLine({
      prompt: '',
      files: [{ filename: 'a.png', base64: 'iVBOR', mimeType: 'image/png' }],
    });
    expect(line).toMatch(/1 image/i);
    // Doesn't crash on empty prompt + doesn't surface "Mobile: " with
    // no content after it.
    expect(line).not.toMatch(/Mobile:\s*$/);
  });

  it('returns an empty string when there is nothing to echo (no prompt + no files)', () => {
    expect(formatPromptEchoLine({})).toBe('');
    expect(formatPromptEchoLine({ prompt: '', files: [] })).toBe('');
  });
});
