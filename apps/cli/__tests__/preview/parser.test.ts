import { describe, expect, it } from 'vitest';
import {
  parseCloudflaredUrl,
  parseExpoUrl,
  safeParseDetection,
} from '../../src/services/preview/parser';

describe('safeParseDetection', () => {
  it('parses a valid detection JSON', () => {
    const json = JSON.stringify({
      framework: 'Next.js',
      command: 'npm',
      args: ['run', 'dev'],
      port: 3000,
      ready_pattern: 'ready in',
    });
    expect(safeParseDetection(json)).toMatchObject({
      framework: 'Next.js',
      command: 'npm',
      port: 3000,
    });
  });

  it('returns null on invalid JSON', () => {
    expect(safeParseDetection('not json')).toBeNull();
  });

  it('returns null on missing required field', () => {
    expect(safeParseDetection('{"framework":"X"}')).toBeNull();
  });

  it('returns null on null input', () => {
    expect(safeParseDetection(null)).toBeNull();
  });

  it('strips markdown fences if the agent ignored the instructions', () => {
    const wrapped =
      '```json\n{"framework":"Vite","command":"npm","args":["run","dev"],"port":5173,"ready_pattern":"Local:"}\n```';
    expect(safeParseDetection(wrapped)).toMatchObject({ framework: 'Vite' });
  });

  it('extracts a JSON object surrounded by agent prose', () => {
    const noisy = `Here is the detection for this project:

{"framework":"Next.js","command":"npm","args":["run","dev"],"port":3000,"ready_pattern":"ready in"}

Let me know if you need adjustments.`;
    expect(safeParseDetection(noisy)).toMatchObject({
      framework: 'Next.js',
      port: 3000,
    });
  });

  it('handles JSON with nested objects + braces in string values', () => {
    const detection =
      'Sure — {"framework":"Custom","command":"node","args":["server.js"],"port":4000,"ready_pattern":"Server \\u007B ready \\u007D","env":{"HOST":"0.0.0.0"}}';
    const result = safeParseDetection(detection);
    expect(result).toMatchObject({ framework: 'Custom' });
    expect(result?.env).toEqual({ HOST: '0.0.0.0' });
  });

  it('handles leading whitespace + trailing newlines from headless mode', () => {
    const padded =
      '\n\n   {"framework":"Vite","command":"npm","args":["run","dev"],"port":5173,"ready_pattern":"Local:"}\n\n';
    expect(safeParseDetection(padded)).toMatchObject({ framework: 'Vite' });
  });
});

describe('parseCloudflaredUrl', () => {
  it('extracts the trycloudflare URL', () => {
    const stderr =
      'INF | https://random-words-abc.trycloudflare.com |\nINF | + |';
    expect(parseCloudflaredUrl(stderr)).toBe(
      'https://random-words-abc.trycloudflare.com',
    );
  });

  it('returns null when not found', () => {
    expect(parseCloudflaredUrl('no url here')).toBeNull();
  });
});

describe('parseExpoUrl', () => {
  it('extracts the exp.host URL', () => {
    const stdout = '› Tunnel ready.\nexp://xyz.exp.host';
    expect(parseExpoUrl(stdout)).toBe('exp://xyz.exp.host');
  });

  it('returns null when not found', () => {
    expect(parseExpoUrl('no expo url')).toBeNull();
  });
});
