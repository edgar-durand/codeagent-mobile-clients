import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildOnboardingPrompt,
  maybeSendOnboardingWelcome,
  _onboardingSeam,
} from '../../../src/agents/acp/onboarding';

describe('buildOnboardingPrompt', () => {
  it('is a background instruction (not a user message), tailored to the repo, with no-tools rule', () => {
    const p = buildOnboardingPrompt('/workspaces/join-the-queue');
    expect(p).toMatch(/NOT from the user|BACKGROUND TASK/i);
    expect(p).toContain('join-the-queue'); // repo-specific invitation
    expect(p).toContain('/workspaces/join-the-queue');
    expect(p).toMatch(/Beads on Dolt/i); // native memory / issue tracker pitch
    expect(p).toMatch(/CodeAgent Mobile/);
    expect(p).toMatch(/do NOT run any tools|no tools/i); // keep it instant
    expect(p).toMatch(/~110 words|under ~110/); // keep it short
  });

  it('falls back to a generic project label when cwd has no basename', () => {
    expect(buildOnboardingPrompt('')).toContain('this project');
  });
});

describe('maybeSendOnboardingWelcome', () => {
  afterEach(() => vi.restoreAllMocks());

  const WELCOME_REPLY = '👋 Hey — glad you spun this up! Drive me from your phone.';

  function fakeClient() {
    return { prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }) };
  }
  function fakeStreaming(text = WELCOME_REPLY) {
    return {
      beginTurn: vi.fn().mockResolvedValue(undefined),
      getCurrentText: vi.fn().mockReturnValue(text),
      closeAll: vi.fn().mockResolvedValue(undefined),
    };
  }
  function fakeHistory() {
    return {
      appendAgentInitiatedReply: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };
  }
  /** Let the fire-and-forget turn (beginTurn→prompt→closeAll→flush) settle. */
  const settle = () => new Promise((r) => setImmediate(r));

  it('runs the welcome as a recorded turn once + writes the marker when fresh', async () => {
    vi.spyOn(_onboardingSeam, 'disabled').mockReturnValue(false);
    vi.spyOn(_onboardingSeam, 'exists').mockReturnValue(false);
    const write = vi.spyOn(_onboardingSeam, 'write').mockImplementation(() => {});
    const client = fakeClient();
    const streaming = fakeStreaming();
    const history = fakeHistory();

    maybeSendOnboardingWelcome({ client, streaming, history, sessionId: 'sess-123', cwd: '/repo/acme' });
    await settle();

    expect(write).toHaveBeenCalledTimes(1);
    expect(streaming.beginTurn).toHaveBeenCalledTimes(1); // turn boundary (clear+new_turn)
    expect(client.prompt).toHaveBeenCalledTimes(1);
    expect(client.prompt.mock.calls[0][0]).toContain('acme'); // tailored prompt sent
    expect(streaming.closeAll).toHaveBeenCalledTimes(1); // finalized with done:true
    // Reply persisted into the conversation anchor (no user bubble) so it shows
    // in chat when SessionDetail opens after the turn completes.
    expect(history.appendAgentInitiatedReply).toHaveBeenCalledWith(WELCOME_REPLY);
    expect(history.flush).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-send when the session was already welcomed (marker exists)', () => {
    vi.spyOn(_onboardingSeam, 'disabled').mockReturnValue(false);
    vi.spyOn(_onboardingSeam, 'exists').mockReturnValue(true);
    const write = vi.spyOn(_onboardingSeam, 'write').mockImplementation(() => {});
    const client = fakeClient();
    const streaming = fakeStreaming();
    const history = fakeHistory();

    maybeSendOnboardingWelcome({ client, streaming, history, sessionId: 'sess-123', cwd: '/repo/acme' });

    expect(client.prompt).not.toHaveBeenCalled();
    expect(streaming.beginTurn).not.toHaveBeenCalled();
    expect(history.flush).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('is a complete no-op when the kill-switch is set (never touches the marker or client)', () => {
    vi.spyOn(_onboardingSeam, 'disabled').mockReturnValue(true);
    const exists = vi.spyOn(_onboardingSeam, 'exists');
    const client = fakeClient();
    const streaming = fakeStreaming();
    const history = fakeHistory();

    maybeSendOnboardingWelcome({ client, streaming, history, sessionId: 'sess-123', cwd: '/repo/acme' });

    expect(exists).not.toHaveBeenCalled();
    expect(client.prompt).not.toHaveBeenCalled();
    expect(streaming.beginTurn).not.toHaveBeenCalled();
  });

  it('skips (no send) when the marker write throws — avoids a re-welcome loop', () => {
    vi.spyOn(_onboardingSeam, 'disabled').mockReturnValue(false);
    vi.spyOn(_onboardingSeam, 'exists').mockReturnValue(false);
    vi.spyOn(_onboardingSeam, 'write').mockImplementation(() => {
      throw new Error('EACCES');
    });
    const client = fakeClient();
    const streaming = fakeStreaming();
    const history = fakeHistory();

    maybeSendOnboardingWelcome({ client, streaming, history, sessionId: 'sess-123', cwd: '/repo/acme' });

    expect(client.prompt).not.toHaveBeenCalled();
    expect(streaming.beginTurn).not.toHaveBeenCalled();
  });
});
