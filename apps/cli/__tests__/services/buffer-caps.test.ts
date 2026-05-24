import { describe, it, expect } from 'vitest';

import { PtyBuffer } from '../../src/services/output/pty-buffer';

/**
 * Buffer-cap regression spec (#57).
 *
 * Without the caps, a multi-MB tool dump in a single turn (Claude
 * dumping a large compaction state; Codex piping a wide diff) made
 * `PtyBuffer.raw` and `StreamingEmitter.rawBuffer` grow linearly
 * until the CLI got OOM-killed. The cap fires when content exceeds
 * 2MB and head-truncates to 1.5MB so the renderToLines pass after
 * the cap still sees the current screen frame (line-anchored).
 *
 * StreamingEmitter has the same cap shape but its private
 * `rawBuffer` isn't observable from the outside without booting the
 * full emitter (which then expects auth + transport). The
 * PtyBuffer assertion covers the shared invariant — both buffers
 * use the same const set.
 */
describe('PtyBuffer raw-byte cap', () => {
  it('keeps small pushes intact', () => {
    const buf = new PtyBuffer();
    buf.push('hello world');
    expect(buf.size).toBe(11);
    expect(buf.content).toBe('hello world');
  });

  it('caps the accumulator under 2 MB and head-truncates when crossed', () => {
    const buf = new PtyBuffer();
    // Push 3 MB total in 256 KB chunks. Each push is well above the
    // cap, so the truncation logic fires repeatedly. We expect the
    // buffer to end somewhere in the 1.5 MB – 2 MB range.
    const CHUNK = 'A'.repeat(256 * 1024);
    for (let i = 0; i < 12; i++) {
      buf.push(CHUNK);
    }
    // Lower bound: TAIL_KEEP_BYTES (1.5MB) — anything below means
    // the cap is over-aggressive.
    expect(buf.size).toBeGreaterThanOrEqual(1.5 * 1024 * 1024);
    // Upper bound: MAX_RAW_BYTES (2MB) plus one chunk of pre-truncate
    // overshoot. Anything above means the cap fired late.
    expect(buf.size).toBeLessThanOrEqual(2 * 1024 * 1024 + 256 * 1024);
  });

  it('preserves the TAIL of the buffer (most recent bytes survive)', () => {
    const buf = new PtyBuffer();
    // Push a heap-stressing prefix, then a unique tail. After the
    // cap fires, the tail must still be reachable verbatim — the
    // renderToLines pass after truncation depends on it.
    buf.push('X'.repeat(3 * 1024 * 1024));
    buf.push('UNIQUE-TAIL-MARKER');
    expect(buf.content.endsWith('UNIQUE-TAIL-MARKER')).toBe(true);
  });

  it('deactivate() still clears the buffer (cap doesn\'t interfere with normal lifecycle)', () => {
    const buf = new PtyBuffer();
    buf.push('Y'.repeat(3 * 1024 * 1024));
    buf.deactivate();
    expect(buf.size).toBe(0);
    expect(buf.content).toBe('');
  });
});
