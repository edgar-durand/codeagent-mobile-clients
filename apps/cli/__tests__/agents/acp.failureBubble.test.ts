/**
 * Regression — a failed `start_task` turn must ALWAYS end with a VISIBLE
 * terminal frame, never silence.
 *
 * The bug (recurring "first message never answers" on a fresh codespace): the
 * first user prompt is the first real agent call routed through the local
 * Headroom proxy on :8787. If the proxy isn't ready (or any non-auth error
 * hits before a token streams), the runner's `recoverFromFailedTurn` →
 * `closeAll` publishes only an EMPTY `text done:true`. The mobile snapshot-guard
 * deliberately drops empty terminal frames, so the chat sits showing the
 * welcome card with NO reply and NO error — the user thinks the app is broken.
 *
 * `failureBubble` is the contract that prevents that: every non-text failure
 * yields a non-empty, actionable bubble the runner publishes with done:true.
 *
 * REGRESSION PROOF: before the fix the catch only published a bubble for AUTH
 * failures; a non-auth no-text failure fell through to the dropped empty frame.
 * The second case below FAILS against that pre-fix runner.
 */
import { describe, expect, it } from 'vitest';
import {
  failureBubble,
  AUTH_FAILURE_MESSAGE,
  TURN_FAILURE_MESSAGE,
} from '../../src/agents/acp/runner';

describe('failureBubble — every failed start_task ends with a visible terminal frame', () => {
  it('auth failure → the actionable re-auth bubble (regardless of streamed text)', () => {
    expect(
      failureBubble({
        detail: 'Internal error: API Error: 401 Invalid authentication credentials',
        recentStderr: '',
        hadText: false,
      }),
    ).toBe(AUTH_FAILURE_MESSAGE);
    // Auth signal can also arrive on stderr while some text streamed.
    expect(
      failureBubble({ detail: 'boom', recentStderr: 'please run /login', hadText: true }),
    ).toBe(AUTH_FAILURE_MESSAGE);
  });

  it('NON-auth failure with NO streamed text → generic retry bubble (the silent first-message bug)', () => {
    // The Headroom proxy not ready on :8787 — the exact first-prompt failure.
    expect(
      failureBubble({
        detail: 'connect ECONNREFUSED 127.0.0.1:8787',
        recentStderr: '',
        hadText: false,
      }),
    ).toBe(TURN_FAILURE_MESSAGE);
    // Any other non-auth error before text streams.
    expect(
      failureBubble({ detail: 'Internal error: socket hang up', recentStderr: '', hadText: false }),
    ).toBe(TURN_FAILURE_MESSAGE);
  });

  it('NON-auth failure that DID stream partial text → null (closeAll already published the partial reply)', () => {
    expect(
      failureBubble({ detail: 'stream aborted mid-turn', recentStderr: '', hadText: true }),
    ).toBeNull();
  });

  it('the synthesized bubbles are NON-EMPTY so the mobile renders them (empty done:true is dropped)', () => {
    expect(TURN_FAILURE_MESSAGE.trim().length).toBeGreaterThan(0);
    expect(AUTH_FAILURE_MESSAGE.trim().length).toBeGreaterThan(0);
  });
});
