/**
 * Story — start_task forwards image attachments to ACP as image blocks.
 *
 * Why this test exists
 * --------------------
 * QA Android #290: Nabeel picked 3 images, typed "Check this", tapped
 * send. The agent replied "I don't see anything attached to check." —
 * the ACP runner's start_task handler read only `payload.prompt` and
 * dropped `payload.files` on the floor. Legacy PTY path used to write
 * the files to /tmp and prepend `@<path>` references in the prompt,
 * which Claude's CLI auto-decoded. Under ACP we don't have that escape
 * hatch — the SDK exposes `ContentBlock['image'] = { type, data,
 * mimeType }` so attachments have to ride the prompt as proper image
 * blocks.
 *
 * Expected behaviour
 * ------------------
 * When `start_task` arrives with a `files` array, the ACP client's
 * `prompt(blocks)` is called with:
 *   - one `{ type: 'image', mimeType, data }` block per file that
 *     supplies base64 data,
 *   - a trailing `{ type: 'text', text: <prompt> }` block (when prompt
 *     is non-empty), OR a "Please review the attached image(s)."
 *     placeholder when the user supplied only attachments.
 * Files without base64 are skipped (defensive — never block the prompt
 * on a malformed entry).
 *
 * Test layer
 * ----------
 * The contract under test is `buildAcpPromptBlocks(payload)` — a pure
 * builder extracted from the runner so it's testable without spinning
 * up the SDK / streaming state. The runner then forwards the blocks
 * via `client.prompt(blocks)`.
 */
import { describe, it, expect } from 'vitest';
import { buildAcpPromptBlocks } from '../../src/agents/acp/buildAcpPromptBlocks';

describe('story: ACP start_task / image attachments', () => {
  it('returns a single text block when no files are attached', () => {
    const blocks = buildAcpPromptBlocks({ prompt: 'Hello' });
    expect(blocks).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('prepends one image block per file with base64 data and appends the text prompt', () => {
    const blocks = buildAcpPromptBlocks({
      prompt: 'Check this',
      files: [
        { filename: 'a.png', base64: 'iVBORw0KGgo=', mimeType: 'image/png' },
        { filename: 'b.jpg', base64: '/9j/4AAQ', mimeType: 'image/jpeg' },
      ],
    });
    expect(blocks).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      { type: 'image', mimeType: 'image/jpeg', data: '/9j/4AAQ' },
      { type: 'text', text: 'Check this' },
    ]);
  });

  it('falls back to a synthetic placeholder when the user attached files without typing a prompt', () => {
    const blocks = buildAcpPromptBlocks({
      prompt: '',
      files: [{ filename: 'a.png', base64: 'iVBORw0KGgo=', mimeType: 'image/png' }],
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: 'iVBORw0KGgo=',
    });
    // Placeholder text — exact copy can churn, but it must be a
    // non-empty text block so the adapter has something to anchor.
    expect(blocks[1]).toMatchObject({ type: 'text' });
    expect((blocks[1] as { type: 'text'; text: string }).text.length).toBeGreaterThan(0);
  });

  it('skips files without base64 data (defensive — never blocks the send)', () => {
    const blocks = buildAcpPromptBlocks({
      prompt: 'Check',
      files: [
        { filename: 'a.png', base64: '', mimeType: 'image/png' },
        { filename: 'b.jpg', base64: '/9j/4AAQ', mimeType: 'image/jpeg' },
      ],
    });
    expect(blocks).toEqual([
      { type: 'image', mimeType: 'image/jpeg', data: '/9j/4AAQ' },
      { type: 'text', text: 'Check' },
    ]);
  });

  it('infers mimeType from filename when the caller omits it', () => {
    const blocks = buildAcpPromptBlocks({
      prompt: 'a',
      files: [{ filename: 'screenshot.png', base64: 'iVBOR' }],
    });
    expect(blocks[0]).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: 'iVBOR',
    });
  });
});
