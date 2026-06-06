/**
 * Story - Pair: mobile claims the code before the CLI timeout.
 *
 * Why this test exists
 * --------------------
 * QA report #285 (Android, 2026-06-06): `codeam pair` printed
 * "Pairing timed out after 5 minutes" even though the QR was scanned
 * immediately. The CLI status loop can miss the paired state if a GET
 * stalls or intermittent failures stretch the next poll too far.
 *
 * Expected behaviour
 * ------------------
 * A slow status GET does not block later reads from observing
 * `paired:true`, and transient GET failures during the pairing window
 * do not make the CLI timeout after the mobile app has claimed the code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pollStatus, _transport } from '../../src/services/pairing.service';

const PLUGIN_ID = 'cmq2de1ep003ocs9urlgjtybp';

function pairedResponse() {
  return {
    data: {
      paired: true,
      sessionId: 'sess_285',
      pluginAuthToken: 'v1.paired-token',
      user: {
        id: 'user_285',
        name: 'Nabeel',
        email: 'nabeel@example.com',
        plan: 'PRO',
      },
    },
  };
}

describe('story: pair / poll observes paired state before timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fires onPaired when the first status GET stalls past the mobile claim', async () => {
    let paired = false;
    let calls = 0;
    vi.spyOn(_transport, 'getJson').mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          setTimeout(() => resolve({ data: { paired: false } }), 5_000);
        });
      }
      return Promise.resolve(paired ? pairedResponse() : { data: { paired: false } });
    });

    const onPaired = vi.fn();
    const onTimeout = vi.fn();
    pollStatus(PLUGIN_ID, onPaired, onTimeout);

    await vi.advanceTimersByTimeAsync(1_000);
    paired = true;
    await vi.advanceTimersByTimeAsync(5_900);

    expect(onPaired).toHaveBeenCalledWith({
      sessionId: 'sess_285',
      userId: 'user_285',
      userName: 'Nabeel',
      userEmail: 'nabeel@example.com',
      plan: 'PRO',
      pluginAuthToken: 'v1.paired-token',
    });
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('keeps polling through intermittent status GET failures near the timeout window', async () => {
    let paired = false;
    let calls = 0;
    vi.spyOn(_transport, 'getJson').mockImplementation(() => {
      calls += 1;
      if (calls % 2 === 1) {
        return Promise.reject(new Error('network blip'));
      }
      return Promise.resolve(paired ? pairedResponse() : { data: { paired: false } });
    });

    const onPaired = vi.fn();
    const onTimeout = vi.fn();
    pollStatus(PLUGIN_ID, onPaired, onTimeout);

    await vi.advanceTimersByTimeAsync(240_000);
    paired = true;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(onPaired).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess_285',
        pluginAuthToken: 'v1.paired-token',
      }),
    );
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
