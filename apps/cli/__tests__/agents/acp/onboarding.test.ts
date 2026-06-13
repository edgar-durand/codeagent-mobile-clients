import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildOnboardingWelcome,
  maybeSendOnboardingWelcome,
  _onboardingSeam,
} from '../../../src/agents/acp/onboarding';

describe('buildOnboardingWelcome', () => {
  it('is a hardcoded welcome tailored to the repo, with the core features + feedback links', () => {
    const w = buildOnboardingWelcome('/workspaces/join-the-queue');
    expect(w).toMatch(/CodeAgent Mobile/);
    expect(w).toMatch(/Beads/i); // native memory / issue tracker pitch
    expect(w).toContain('join-the-queue'); // repo-specific CTA
    expect(w).toMatch(/Monaco/);
    expect(w).toMatch(/Smart Composer/);
    expect(w).toMatch(/Team Spaces/);
    // Collaboration / feedback channels — full URLs so they render tappable.
    expect(w).toContain('https://github.com/edgar-durand/codeagent-mobile-clients/issues');
    expect(w).toContain('https://discord.gg/ADMKwGAB');
  });

  it('falls back to a generic project label when cwd has no basename', () => {
    expect(buildOnboardingWelcome('')).toContain('this project');
  });
});

describe('maybeSendOnboardingWelcome', () => {
  afterEach(() => vi.restoreAllMocks());

  function fakeStreaming() {
    return {
      beginTurn: vi.fn().mockResolvedValue(undefined),
      append: vi.fn(),
      closeAll: vi.fn().mockResolvedValue(undefined),
    };
  }
  function fakeHistory() {
    return {
      appendAgentInitiatedReply: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };
  }
  /** Let the fire-and-forget turn (beginTurn→append→closeAll→flush) settle. */
  const settle = () => new Promise((r) => setImmediate(r));

  it('publishes the hardcoded welcome as a recorded turn once + writes the marker when fresh', async () => {
    vi.spyOn(_onboardingSeam, 'disabled').mockReturnValue(false);
    vi.spyOn(_onboardingSeam, 'exists').mockReturnValue(false);
    const write = vi.spyOn(_onboardingSeam, 'write').mockImplementation(() => {});
    const streaming = fakeStreaming();
    const history = fakeHistory();

    maybeSendOnboardingWelcome({ streaming, history, sessionId: 'sess-123', cwd: '/repo/acme' });
    await settle();

    const expected = buildOnboardingWelcome('/repo/acme');
    expect(write).toHaveBeenCalledTimes(1);
    expect(streaming.beginTurn).toHaveBeenCalledTimes(1); // turn boundary (clear+new_turn)
    // Hardcoded text appended as a single text chunk — NO agent round-trip.
    expect(streaming.append).toHaveBeenCalledWith({
      chunkId: 'onboarding-welcome',
      kind: 'text',
      delta: expected,
    });
    expect(streaming.closeAll).toHaveBeenCalledTimes(1); // finalized with done:true
    // Persisted into the conversation anchor (no user bubble) so it shows in
    // chat when SessionDetail opens after the turn completes.
    expect(history.appendAgentInitiatedReply).toHaveBeenCalledWith(expected);
    expect(history.flush).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-send when the session was already welcomed (marker exists)', () => {
    vi.spyOn(_onboardingSeam, 'disabled').mockReturnValue(false);
    vi.spyOn(_onboardingSeam, 'exists').mockReturnValue(true);
    const write = vi.spyOn(_onboardingSeam, 'write').mockImplementation(() => {});
    const streaming = fakeStreaming();
    const history = fakeHistory();

    maybeSendOnboardingWelcome({ streaming, history, sessionId: 'sess-123', cwd: '/repo/acme' });

    expect(streaming.beginTurn).not.toHaveBeenCalled();
    expect(history.flush).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('is a complete no-op when the kill-switch is set (never touches the marker)', () => {
    vi.spyOn(_onboardingSeam, 'disabled').mockReturnValue(true);
    const exists = vi.spyOn(_onboardingSeam, 'exists');
    const streaming = fakeStreaming();
    const history = fakeHistory();

    maybeSendOnboardingWelcome({ streaming, history, sessionId: 'sess-123', cwd: '/repo/acme' });

    expect(exists).not.toHaveBeenCalled();
    expect(streaming.beginTurn).not.toHaveBeenCalled();
  });

  it('skips (no send) when the marker write throws — avoids a re-welcome loop', () => {
    vi.spyOn(_onboardingSeam, 'disabled').mockReturnValue(false);
    vi.spyOn(_onboardingSeam, 'exists').mockReturnValue(false);
    vi.spyOn(_onboardingSeam, 'write').mockImplementation(() => {
      throw new Error('EACCES');
    });
    const streaming = fakeStreaming();
    const history = fakeHistory();

    maybeSendOnboardingWelcome({ streaming, history, sessionId: 'sess-123', cwd: '/repo/acme' });

    expect(streaming.beginTurn).not.toHaveBeenCalled();
  });
});
