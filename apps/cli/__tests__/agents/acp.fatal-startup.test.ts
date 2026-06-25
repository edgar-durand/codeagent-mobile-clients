import { describe, it, expect } from 'vitest';
import { FATAL_STARTUP_RE } from '../../src/agents/acp/client';

/**
 * `gemini --acp` logs a fatal Code Assist onboarding error to stderr but never
 * rejects the `newSession` RPC, so the session would hang forever ("STILL
 * LOADING SESSION HISTORY" / offline). The client watches stderr for these
 * patterns to fail `newSession` fast with the real cause. This pins the
 * detection so the patterns don't silently drift.
 */
describe('FATAL_STARTUP_RE', () => {
  it('matches the post-2026-06-18 Gemini free-tier deprecation error', () => {
    expect(
      FATAL_STARTUP_RE.test(
        'Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.',
      ),
    ).toBe(true);
    expect(FATAL_STARTUP_RE.test('reasonCode: UNSUPPORTED_CLIENT')).toBe(true);
    expect(FATAL_STARTUP_RE.test('ProjectIdRequiredError: requires GOOGLE_CLOUD_PROJECT')).toBe(true);
  });

  it('does NOT match benign adapter stderr (progress / info lines)', () => {
    expect(FATAL_STARTUP_RE.test('Loaded cached credentials.')).toBe(false);
    expect(FATAL_STARTUP_RE.test('[info] starting MCP server')).toBe(false);
    expect(FATAL_STARTUP_RE.test('Flushing log events to Clearcut.')).toBe(false);
  });
});
