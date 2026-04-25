import { describe, test, expect } from 'vitest';
import {
  parsePayload,
  startCommandSchema,
  fileEntrySchema,
} from '../../src/lib/payload';

describe('parsePayload', () => {
  test('accepts valid start payload', () => {
    const r = parsePayload(startCommandSchema, { prompt: 'hi' });
    expect(r).not.toBeNull();
    expect(r?.prompt).toBe('hi');
  });

  test('returns null on malformed file entry (empty filename)', () => {
    expect(
      parsePayload(startCommandSchema, {
        files: [{ filename: '', mimeType: 'text/plain', base64: 'eA==' }],
      }),
    ).toBeNull();
  });

  test('returns null when prompt is wrong type', () => {
    expect(parsePayload(startCommandSchema, { prompt: 123 })).toBeNull();
  });

  test('treats undefined optionals as undefined (not error)', () => {
    const r = parsePayload(startCommandSchema, {});
    expect(r).not.toBeNull();
    expect(r?.prompt).toBeUndefined();
    expect(r?.files).toBeUndefined();
    expect(r?.input).toBeUndefined();
    expect(r?.id).toBeUndefined();
  });

  test('rejects when filename exceeds 256 chars', () => {
    expect(
      parsePayload(fileEntrySchema, {
        filename: 'a'.repeat(257),
        mimeType: 'text/plain',
        base64: 'eA==',
      }),
    ).toBeNull();
  });
});
