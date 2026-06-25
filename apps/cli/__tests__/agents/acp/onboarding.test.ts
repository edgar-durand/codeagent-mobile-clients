import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildOnboardingWelcome,
  maybeSendOnboardingWelcome,
  resolveRepoName,
  _onboardingSeam,
} from '../../../src/agents/acp/onboarding';

describe('buildOnboardingWelcome', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is a hardcoded welcome tailored to the repo, with the core features + feedback links', () => {
    // No git remote at this fake path → basename fallback (`join-the-queue`).
    vi.spyOn(_onboardingSeam, 'gitRemoteUrl').mockReturnValue(null);
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

describe('resolveRepoName', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prefers the git origin remote — even when the dir is named after a session UUID (codespace/self-hosted clone)', () => {
    // The bug: the repo is cloned into a UUID-named dir, so basename(cwd) is a
    // UUID. The git remote carries the real owner/repo.
    const uuidDir = '/workspaces/a2480d74-aaa4-442d-91cc-2a6c595b3560';
    vi.spyOn(_onboardingSeam, 'gitRemoteUrl').mockReturnValue(
      'https://github.com/edgar-durand/join-the-queue.git',
    );
    expect(resolveRepoName(uuidDir)).toBe('join-the-queue');
  });

  it('parses an SSH remote URL too', () => {
    vi.spyOn(_onboardingSeam, 'gitRemoteUrl').mockReturnValue('git@github.com:acme/widgets.git');
    expect(resolveRepoName('/anything')).toBe('widgets');
  });

  it('falls back to the basename when it is a normal name and there is no remote', () => {
    vi.spyOn(_onboardingSeam, 'gitRemoteUrl').mockReturnValue(null);
    expect(resolveRepoName('/home/user/my-project')).toBe('my-project');
  });

  it('never leaks a UUID dir name — falls back to a generic label when there is no remote', () => {
    vi.spyOn(_onboardingSeam, 'gitRemoteUrl').mockReturnValue(null);
    expect(resolveRepoName('/workspaces/a2480d74-aaa4-442d-91cc-2a6c595b3560')).toBe('this project');
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
    expect(streaming.beginTurn).toHaveBeenCalledTimes(1);
    // clear:false — must NOT flush the agent_banner card published just
    // before onboarding from the backend catchup buffer (welcome-card bug).
    expect(streaming.beginTurn).toHaveBeenCalledWith({ clear: false });
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

  it('on resume (marker exists) re-seeds the welcome into history WITHOUT re-publishing it live', () => {
    vi.spyOn(_onboardingSeam, 'disabled').mockReturnValue(false);
    vi.spyOn(_onboardingSeam, 'exists').mockReturnValue(true);
    const write = vi.spyOn(_onboardingSeam, 'write').mockImplementation(() => {});
    const streaming = fakeStreaming();
    const history = fakeHistory();

    maybeSendOnboardingWelcome({ streaming, history, sessionId: 'sess-123', cwd: '/repo/acme' });

    // No LIVE re-send: no turn, no flush, marker untouched.
    expect(streaming.beginTurn).not.toHaveBeenCalled();
    expect(history.flush).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    // But the welcome IS re-seeded into this run's (empty-on-resume) history,
    // so a later flush (e.g. a failed/auth turn that REPLACES the durable
    // conversation) can't drop the welcome banner the user still sees.
    expect(history.appendAgentInitiatedReply).toHaveBeenCalledWith(
      buildOnboardingWelcome('/repo/acme'),
    );
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

  // #339 — the first user prompt sometimes got answered by the greeting.
  // Root cause: the welcome turn was fire-and-forget and could still be open
  // (mid beginTurn→append→closeAll) when the relay began the first command
  // turn on the SAME shared StreamingState, so the two interleaved on one
  // buffer. The runner now `await`s this before `relay.start()`. For that to
  // actually serialize, the returned promise MUST NOT resolve until the
  // welcome turn has fully closed (closeAll). This pins that contract.
  it('resolves only AFTER the welcome turn closes, so the relay can serialize against it (#339)', async () => {
    vi.spyOn(_onboardingSeam, 'disabled').mockReturnValue(false);
    vi.spyOn(_onboardingSeam, 'exists').mockReturnValue(false);
    vi.spyOn(_onboardingSeam, 'write').mockImplementation(() => {});

    // Gate closeAll so we can observe the promise's resolution timing
    // relative to the turn actually closing.
    let releaseCloseAll: () => void = () => {};
    const closeAllGate = new Promise<void>((resolve) => {
      releaseCloseAll = resolve;
    });
    let turnClosed = false;
    const streaming = {
      beginTurn: vi.fn().mockResolvedValue(undefined),
      append: vi.fn(),
      closeAll: vi.fn().mockImplementation(async () => {
        await closeAllGate;
        turnClosed = true;
      }),
    };
    const history = fakeHistory();

    let promiseResolved = false;
    const done = maybeSendOnboardingWelcome({
      streaming,
      history,
      sessionId: 'sess-123',
      cwd: '/repo/acme',
    }).then(() => {
      promiseResolved = true;
    });

    // Let microtasks run: the turn has begun + appended but closeAll is gated.
    await new Promise((r) => setImmediate(r));
    expect(streaming.beginTurn).toHaveBeenCalledTimes(1);
    expect(turnClosed).toBe(false);
    // The relay-awaited promise MUST still be pending while the turn is open —
    // otherwise relay.start() could begin a command turn mid-welcome.
    expect(promiseResolved).toBe(false);

    // Close the welcome turn → the promise resolves, and only now is it safe
    // for the relay to start its own turn.
    releaseCloseAll();
    await done;
    expect(turnClosed).toBe(true);
    expect(promiseResolved).toBe(true);
  });
});
