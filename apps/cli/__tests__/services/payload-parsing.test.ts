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

  // Regression: the agent writes preview setup_commands as bare strings
  // ("npx prisma generate"); the schema must accept them and normalize to
  // {cmd,args} rather than rejecting the whole detection (which silently
  // dropped the preview → black screen on a Prisma/Next.js codespace).
  const baseDetection = {
    framework: 'Next.js',
    command: 'npx',
    args: ['next', 'dev', '-H', '0.0.0.0', '-p', '3000'],
    port: 3000,
    ready_pattern: '(Ready in|Local:\\s+http)',
    env: { HOST: '0.0.0.0' },
  };

  test('normalizes string setup_commands into {cmd,args}', () => {
    const r = parsePayload(startCommandSchema, {
      detection: { ...baseDetection, setup_commands: ['npx prisma generate'] },
    });
    expect(r).not.toBeNull();
    expect(r?.detection?.setup_commands).toEqual([
      { cmd: 'npx', args: ['prisma', 'generate'] },
    ]);
  });

  test('accepts object setup_commands unchanged', () => {
    const r = parsePayload(startCommandSchema, {
      detection: {
        ...baseDetection,
        setup_commands: [{ cmd: 'npx', args: ['prisma', 'generate'] }],
      },
    });
    expect(r?.detection?.setup_commands).toEqual([
      { cmd: 'npx', args: ['prisma', 'generate'] },
    ]);
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
