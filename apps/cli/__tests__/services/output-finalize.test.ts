import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { OutputService, _transport } from '../../src/services/output.service';
import type { RuntimeStrategy } from '../../src/agents/strategy';
import { LinuxOsStrategy } from '../../src/os';
import type { ChromeStep, SelectPrompt } from '@codeam/shared';

/**
 * Regression tests for the canonical-refresh-never-fires bug.
 *
 * Symptoms: snippets render as plain monospace text without the
 * CodeBlock chrome because the webapp's canonical-refresh path
 * (gated on `isDoneChunk`) never sees a `done: true` chunk.
 *
 * Root cause: Claude's TUI keeps redrawing the spinner + shortcuts
 * prompt after the response settles. `pty.lastPushTime` therefore
 * never sits idle ≥ IDLE_MS, the legacy finalize heuristic never
 * trips, and `OutputService.finalize()` never fires. These tests
 * pin the two new finalize triggers (content-stable + ready-prompt,
 * and content-stable fallback) so a future refactor that drops
 * either path breaks loudly here instead of in production.
 */

interface PostCall {
  url: string;
  headers: Record<string, string>;
  payload: string;
}

interface StubRuntimeOptions {
  /** Filtered lines returned each tick (drives the content-stability clock). */
  contentLines: string[];
  /** Lines visible in the rendered view — includes the spinner + shortcut prompt. */
  renderedLines: string[];
  /** What the agent's `detectReadyPrompt` returns this tick. */
  ready?: boolean;
}

/**
 * Minimal RuntimeStrategy that lets tests drive what `tick()` sees
 * without standing up the real PTY → renderToLines → filterChrome
 * chain. Every method only returns what `tick()` actually consults.
 */
function makeRuntime(opts: StubRuntimeOptions): RuntimeStrategy {
  return {
    id: 'claude',
    meta: {
      id: 'claude',
      displayName: 'Claude Code',
      binaryName: 'claude',
      enabled: true,
      supportedAuthKinds: ['oauth_token'],
      preferredAuthKind: 'oauth_token',
    },
    mode: 'interactive' as const,
    os: new LinuxOsStrategy(),
    prepareLaunch: async () => ({ cmd: 'claude', args: [] }),
    resumeLaunchArgs: () => [],
    resolveHistoryDir: () => null,
    parseHistoryFile: () => [],
    getCurrentUsage: () => null,
    fetchWeeklyUsage: async () => null,
    listModels: async () => [],
    changeModelInstruction: () => ({ type: 'pty' as const, ptyInput: '' }),
    summarizeInstruction: () => ({ ptyInput: '' }),
    renderToLines: (_raw: string) => opts.renderedLines,
    parseTuiChrome: (_line: string): ChromeStep | null => null,
    filterTuiOutput: (_lines) => opts.contentLines,
    detectInteractivePrompt: (_lines): SelectPrompt | null => null,
    detectReadyPrompt: (_lines): boolean => opts.ready ?? false,
    credentialLocator: () => ({
      publicId: 'claude_code',
      vendor: 'Anthropic',
      hint: '',
      watchPaths: () => [],
      extract: async () => null,
    }),
    loginLauncher: () => ({
      ensureInstalled: async () => true,
      launch: () => { throw new Error('not used in this spec'); },
    }),
  };
}

/** Capture every `_transport.post` call so the test can assert what
 *  was sent to /api/commands/output. */
function captureTransport(): { calls: PostCall[]; restore: () => void } {
  const calls: PostCall[] = [];
  const spy = vi.spyOn(_transport, 'post').mockImplementation((url, headers, payload) => {
    calls.push({ url, headers, payload });
    return Promise.resolve({ statusCode: 200, body: '{}' });
  });
  return {
    calls,
    restore: () => spy.mockRestore(),
  };
}

function lastTextChunk(calls: PostCall[]): {
  type: string;
  content?: string;
  done?: boolean;
} | null {
  for (let i = calls.length - 1; i >= 0; i--) {
    try {
      const body = JSON.parse(calls[i].payload);
      if (body.type === 'text') return body;
    } catch { /* skip malformed */ }
  }
  return null;
}

describe('OutputService finalize triggers — canonical-refresh fix', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('finalizes via READY_STABLE_MS when content stable + agent reports ready', async () => {
    const { calls, restore } = captureTransport();
    const runtime = makeRuntime({
      contentLines: ['type User = {', '  id: string;', '};'],
      // Rendered view includes the spinner — `pty.lastPushTime` will
      // keep bumping. The agent runtime reports `ready = true`,
      // simulating Claude's `? for shortcuts` or Codex's `│ › │` box.
      renderedLines: [
        '⏺ type User = {',
        '    id: string;',
        '  };',
        '',
        '✳ Thinking… (still drawing — should NOT block finalize)',
      ],
      ready: true,
    });

    const svc = new OutputService(
      'sess-ready',
      'plg-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runtime,
    );
    svc.newTurn();
    // Push a byte so the PTY buffer treats the turn as active and
    // ticks process content (push activates the buffer + sets
    // lastPushTime so we cross WARMUP_MS).
    svc.push('printable text\n');

    // Past WARMUP_MS (1.5 s) + one tick to register content +
    // READY_STABLE_MS (800 ms) to actually finalize.
    await vi.advanceTimersByTimeAsync(1600); // first content-tick happens here
    // Simulate Claude redrawing the spinner — bumps lastPushTime so
    // the legacy idleMs path can't fire. Content stays identical.
    svc.push('still drawing spinner');
    await vi.advanceTimersByTimeAsync(900);
    svc.push('still drawing spinner');
    await vi.advanceTimersByTimeAsync(900);

    // Drain microtasks so any pending `.catch(() => {})` settled.
    await vi.runAllTimersAsync();

    const final = lastTextChunk(calls);
    expect(final).not.toBeNull();
    expect(final!.done).toBe(true);
    expect(final!.content).toContain('type User');
    svc.dispose();
    restore();
  });

  it('finalizes via CONTENT_STABLE_MS fallback when ready signal never fires', async () => {
    const { calls, restore } = captureTransport();
    const runtime = makeRuntime({
      contentLines: ['function findUser(id) {', '  // …', '}'],
      // No ready signal — older TUI / headless run / agent that
      // doesn't implement `detectReadyPrompt`. Only the hard
      // content-stable fallback can trigger.
      renderedLines: [
        '⏺ function findUser(id) {',
        '    // …',
        '  }',
        '✳ thinking (spinner)',
      ],
      ready: false,
    });

    const svc = new OutputService(
      'sess-fallback',
      'plg-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runtime,
    );
    svc.newTurn();
    svc.push('printable');

    // Past WARMUP, then sit on the stability clock for ≥ CONTENT_STABLE_MS
    // (8 s). Keep pushing spinner bytes the whole time so idleMs
    // never crosses IDLE_MS — the only path that can finalise is
    // the new content-stable fallback.
    for (let i = 0; i < 10; i++) {
      svc.push('spinner-tick');
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.runAllTimersAsync();

    const final = lastTextChunk(calls);
    expect(final).not.toBeNull();
    expect(final!.done).toBe(true);
    expect(final!.content).toContain('findUser');
    svc.dispose();
    restore();
  });

  it('does NOT finalize while content is still changing (long real turn)', async () => {
    const state = {
      contentLines: ['line 1'],
      renderedLines: ['⏺ line 1', '✳ Thinking…'],
      // ready stays false — the agent is actively working.
      ready: false,
    };
    const { calls, restore } = captureTransport();

    // Drive a fresh runtime each tick by mutating the shared `state`
    // — the stub captures it by reference.
    const runtime = makeRuntime(state);

    const svc = new OutputService(
      'sess-streaming',
      'plg-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runtime,
    );
    svc.newTurn();
    svc.push('printable');
    await vi.advanceTimersByTimeAsync(1600);

    // Simulate Claude actively writing more content every tick for
    // ~12 s. The stability clock keeps resetting; neither new
    // finalize branch should ever fire while content keeps churning.
    for (let i = 2; i <= 12; i++) {
      state.contentLines = [`line 1`, `line ${i}`];
      state.renderedLines = [`⏺ line 1`, `⏺ line ${i}`, '✳ Thinking…'];
      svc.push('stream byte');
      await vi.advanceTimersByTimeAsync(1000);
    }

    // Don't drain ALL pending timers here — setInterval reschedules
    // forever and would eventually let CONTENT_STABLE_MS trip after
    // the test loop stopped mutating `state`. Assertion is "no
    // done:true yet at the 12 s mark" — i.e. the mid-turn streaming
    // window stays open while content is actively changing.
    const final = lastTextChunk(calls);
    expect(final).not.toBeNull();
    expect(final!.done).toBeFalsy();
    svc.dispose();
    restore();
  });
});
