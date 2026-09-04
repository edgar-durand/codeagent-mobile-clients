import { describe, expect, it } from 'vitest';
import {
  describeDetectionFailure,
  isUnsupportedDetection,
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

  it('accepts the prompt\'s own "no dev server" answer instead of calling it malformed', () => {
    // The exact answer a user's Claude gave 11 times in 3 days for a native
    // Android app (2026-09-01→04). Until now it was rejected as "missing
    // command, args, port, ready_pattern" and shown as Detection Failed with
    // a Retry button — the handler's `unsupported` branch was unreachable.
    const raw =
      '{"framework":"unsupported","notes":"Native Android app (Kotlin + Jetpack Compose, Gradle multi-module). No dev server — run via Android emulator/device with `gradlew :app:installDebug`."}';
    const result = safeParseDetection(raw);
    expect(result).not.toBeNull();
    if (!result || !isUnsupportedDetection(result))
      throw new Error('expected an unsupported verdict');
    expect(result.notes).toMatch(/Native Android app/);
    // The diagnosis agrees with the decision: nothing to report as a failure.
    expect(describeDetectionFailure(raw)).toBeNull();
    // Fenced, as headless agents often wrap it.
    expect(safeParseDetection('```json\n{"framework":"unsupported"}\n```')).toEqual({
      framework: 'unsupported',
      notes: undefined,
    });
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
    if (!result || isUnsupportedDetection(result)) throw new Error('expected a runnable detection');
    expect(result.env).toEqual({ HOST: '0.0.0.0' });
  });

  it('handles leading whitespace + trailing newlines from headless mode', () => {
    const padded =
      '\n\n   {"framework":"Vite","command":"npm","args":["run","dev"],"port":5173,"ready_pattern":"Local:"}\n\n';
    expect(safeParseDetection(padded)).toMatchObject({ framework: 'Vite' });
  });
});

describe('parseCloudflaredUrl', () => {
  it('extracts the trycloudflare URL', () => {
    const stderr = 'INF | https://random-words-abc.trycloudflare.com |\nINF | + |';
    expect(parseCloudflaredUrl(stderr)).toBe('https://random-words-abc.trycloudflare.com');
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
