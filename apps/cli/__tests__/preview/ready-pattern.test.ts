/**
 * Regression test for `compileReadyPattern`.
 *
 * Real-world failure (June 2026, codespace
 * `codeagent-mobile-p6gv9565jpgcr4wv`): the agent's preview detection
 * emitted `ready_pattern: "ready in|✓ Compiled"` (lowercase `ready`).
 * Next.js 15 actually prints `✓ Ready in 1.5s` (capital R), so the
 * default case-sensitive `new RegExp(pattern)` never matched. The
 * spawn watcher polled for the full 120 s deadline and bailed with
 * `ERR_READY_TIMEOUT` while the dev server was alive and serving
 * the whole time.
 *
 * The fix made the compile case-insensitive. A regression that drops
 * the `i` flag would re-introduce the exact production timeout —
 * these assertions pin both the lowercase-pattern + uppercase-stdout
 * combinations the major dev servers actually emit.
 */

import { describe, expect, it } from 'vitest';
import { compileReadyPattern } from '../../src/commands/start/handlers';

describe('compileReadyPattern', () => {
  it('matches Next.js stdout ("Ready in 1.5s") against the agent\'s lowercase pattern', () => {
    const re = compileReadyPattern('ready in');
    expect(re.test('   ✓ Ready in 1.5s')).toBe(true);
  });

  it('matches Vite stdout ("ready in 320 ms") against the same lowercase pattern', () => {
    const re = compileReadyPattern('ready in');
    expect(re.test('  VITE v5.0.0  ready in 320 ms')).toBe(true);
  });

  it('matches alternations regardless of case', () => {
    const re = compileReadyPattern('ready in|✓ Compiled');
    expect(re.test('✓ Ready in 1.5s')).toBe(true);
    expect(re.test('✓ Compiled successfully in 220ms')).toBe(true);
    expect(re.test('✓ compiled successfully')).toBe(true);
  });

  it('does NOT match an unrelated line', () => {
    const re = compileReadyPattern('ready in');
    expect(re.test('Cannot find module foo')).toBe(false);
  });

  it('handles uppercase patterns the agent might also emit', () => {
    const re = compileReadyPattern('Ready in');
    expect(re.test('ready in 1500ms')).toBe(true);
    expect(re.test('Ready in 1.5s')).toBe(true);
  });
});
