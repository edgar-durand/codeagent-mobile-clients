import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChromeStep, SelectPrompt } from '@codeam/shared';

import {
  StreamingEmitterService,
  classifyLine,
  parsePendingAnswerResponse,
} from '../src/services/streaming-emitter.service';
import type { PtyInput } from '../src/services/streaming-emitter.service';
import { _transport } from '../src/services/streaming/transport';
import { LinuxOsStrategy } from '../src/os';
import type { RuntimeStrategy } from '../src/agents/strategy';
import {
  detectListSelector,
  detectSelector,
  filterChrome,
  isChromeLine,
  parseChromeLine,
} from './fixtures/react-ink-parsers';

const API_BASE = 'https://api.example.test';

/**
 * Build a minimal RuntimeStrategy stub backed by the real Claude
 * parsers — we only need the parsing surface for the emitter tests,
 * the launch / history / quota methods stay no-ops.
 */
function makeRuntime(): RuntimeStrategy {
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
    // Fake os: the test exercises classify/filter/select paths that
    // never touch the OS, so any concrete impl works. LinuxOsStrategy
    // is chosen for stable behaviour on the CI runner.
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
    parseTuiChrome: (line: string): ChromeStep | null => {
      if (!isChromeLine(line)) return null;
      return parseChromeLine(line);
    },
    filterTuiOutput: (lines) => filterChrome(lines),
    detectInteractivePrompt: (lines): SelectPrompt | null =>
      detectSelector(lines) ?? detectListSelector(lines),
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

/**
 * Tracks the calls each pty-input method received. Plain objects so
 * the implementation can be passed as `PtyInput` directly (the
 * vi.fn() typing in vitest 4 doesn't satisfy a function-property
 * interface cleanly).
 */
interface PtyCallLog {
  sendCommand: string[][];
  selectOption: Array<[number, number | undefined]>;
}

function makeService(): {
  svc: StreamingEmitterService;
  pty: PtyInput;
  log: PtyCallLog;
} {
  const log: PtyCallLog = { sendCommand: [], selectOption: [] };
  const pty: PtyInput = {
    sendCommand(text: string) {
      log.sendCommand.push([text]);
    },
    selectOption(targetIndex: number, fromIndex?: number) {
      log.selectOption.push([targetIndex, fromIndex]);
    },
  };
  const svc = new StreamingEmitterService({
    sessionId: 'sess-abc',
    pluginId: 'plugin-1',
    pluginAuthToken: 'token-xyz',
    runtime: makeRuntime(),
    ptyInput: pty,
    apiBaseUrl: API_BASE,
  });
  return { svc, pty, log };
}

// ─── Pure classification ──────────────────────────────────────────────

describe('classifyLine — chunk-kind discrimination', () => {
  const runtime = makeRuntime();
  const parseChrome = runtime.parseTuiChrome?.bind(runtime);

  it('classifies (thinking) lines as `thinking`', () => {
    expect(classifyLine('(thinking)', parseChrome, runtime)).toBe('thinking');
  });

  it('classifies spinner tool-use lines as `tool_use`', () => {
    expect(classifyLine('⠙ Reading src/output.service.ts...', parseChrome, runtime)).toBe(
      'tool_use',
    );
    expect(classifyLine('⠋ Editing src/foo.ts', parseChrome, runtime)).toBe('tool_use');
    expect(classifyLine('⠸ Running npm test', parseChrome, runtime)).toBe('tool_use');
    expect(classifyLine('⠹ Searching for "pattern"', parseChrome, runtime)).toBe('tool_use');
  });

  it('classifies `└ …` tree-continuation lines as `tool_result`', () => {
    expect(classifyLine('└ Read 42 lines', parseChrome, runtime)).toBe('tool_result');
    expect(classifyLine('  └ exit 0', parseChrome, runtime)).toBe('tool_result');
  });

  it('classifies plain agent prose as `text`', () => {
    expect(
      classifyLine('Here is the refactored function:', parseChrome, runtime),
    ).toBe('text');
    expect(
      classifyLine('I have updated the file successfully.', parseChrome, runtime),
    ).toBe('text');
  });

  it('drops pure chrome (separators, empty lines, status bars)', () => {
    expect(classifyLine('', parseChrome, runtime)).toBeNull();
    expect(classifyLine('───────────', parseChrome, runtime)).toBeNull();
    expect(
      classifyLine('  esc to interrupt', parseChrome, runtime),
    ).toBeNull();
  });
});

// ─── Pending-answer envelope parser ───────────────────────────────────

describe('parsePendingAnswerResponse', () => {
  it('parses the `{ data: … }` envelope', () => {
    expect(
      parsePendingAnswerResponse(
        JSON.stringify({ data: { questionId: 'q1', answer: 'yes' } }),
      ),
    ).toEqual({ questionId: 'q1', answer: 'yes' });
  });

  it('parses a bare shape (no envelope)', () => {
    expect(
      parsePendingAnswerResponse(
        JSON.stringify({ questionId: 'q1', answer: 'no', optionIndex: 1 }),
      ),
    ).toEqual({ questionId: 'q1', answer: 'no', optionIndex: 1 });
  });

  it('returns null on malformed input', () => {
    expect(parsePendingAnswerResponse('')).toBeNull();
    expect(parsePendingAnswerResponse('not-json')).toBeNull();
    expect(parsePendingAnswerResponse('{}')).toBeNull();
    expect(parsePendingAnswerResponse(JSON.stringify({ questionId: 'q1' }))).toBeNull();
  });
});

// ─── Service lifecycle + POST surface ─────────────────────────────────

describe('StreamingEmitterService — streaming chunks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('emits a `text` chunk and finalises it when stop() is called', async () => {
    const { svc } = makeService();
    const postSpy = vi
      .spyOn(_transport, 'post')
      .mockResolvedValue({ statusCode: 200, body: '{}' });

    svc.start();
    svc.push('Hello world, this is the agent reply.\n');
    svc._tickForTest();
    await vi.runAllTicks();
    await svc.stop();
    await vi.runAllTicks();

    const chunkPosts = postSpy.mock.calls.filter((c) =>
      c[0].endsWith(`/api/sessions/sess-abc/streaming-chunk`),
    );
    expect(chunkPosts.length).toBeGreaterThanOrEqual(1);
    const bodies = chunkPosts.map((c) => JSON.parse(c[2]));
    const last = bodies[bodies.length - 1];
    expect(last.kind).toBe('text');
    expect(last.content).toContain('Hello world');
    expect(last.isFinal).toBe(true);
    // chunkId is stable across pushes for the same logical chunk.
    const ids = new Set(bodies.map((b) => b.chunkId));
    expect(ids.size).toBe(1);
  });

  it('sends X-Plugin-Auth-Token + protocol version on every POST', async () => {
    const { svc } = makeService();
    const postSpy = vi
      .spyOn(_transport, 'post')
      .mockResolvedValue({ statusCode: 200, body: '{}' });
    svc.start();
    svc.push('Some agent text here.\n');
    svc._tickForTest();
    await vi.runAllTicks();
    await svc.stop();

    expect(postSpy.mock.calls.length).toBeGreaterThan(0);
    for (const [, headers] of postSpy.mock.calls) {
      expect(headers['X-Plugin-Auth-Token']).toBe('token-xyz');
      expect(headers['X-Codeam-Protocol-Version']).toBe('2.0.0');
      expect(headers['Content-Type']).toBe('application/json');
    }
  });

  it('opens a fresh chunkId on kind change (text → tool_use)', async () => {
    const { svc } = makeService();
    const postSpy = vi
      .spyOn(_transport, 'post')
      .mockResolvedValue({ statusCode: 200, body: '{}' });

    svc.start();
    svc.push('Here is what I am about to do:\n');
    svc._tickForTest();
    await vi.runAllTicks();
    svc.push('⠙ Reading src/foo.ts\n');
    svc._tickForTest();
    await vi.runAllTicks();
    await svc.stop();
    await vi.runAllTicks();

    const bodies = postSpy.mock.calls
      .filter((c) => c[0].endsWith(`/api/sessions/sess-abc/streaming-chunk`))
      .map((c) => JSON.parse(c[2]));
    const textPosts = bodies.filter((b) => b.kind === 'text');
    const toolUsePosts = bodies.filter((b) => b.kind === 'tool_use');
    expect(textPosts.length).toBeGreaterThanOrEqual(1);
    expect(toolUsePosts.length).toBeGreaterThanOrEqual(1);
    // Different chunkIds for the two kinds.
    expect(textPosts[0].chunkId).not.toBe(toolUsePosts[0].chunkId);
    // The text chunk must have been finalised before opening the tool-use chunk.
    expect(textPosts.some((b) => b.isFinal === true)).toBe(true);
  });
});

// ─── Awaiting-answer + answer pipeline ────────────────────────────────

describe('StreamingEmitterService — awaiting answer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Numbered React Ink selector exactly as `detectSelector` shipped:
  // two options under a question, anchored on a `❯ 1.` cursor.
  const SELECTOR_BUFFER = [
    'Do you trust the files in this folder?',
    '',
    '❯ 1. Yes, trust them',
    '  2. No, exit',
    '',
  ].join('\n');

  it('POSTs an awaiting-answer event once the selector is stable', async () => {
    const { svc } = makeService();
    const postSpy = vi
      .spyOn(_transport, 'post')
      .mockResolvedValue({ statusCode: 200, body: '{}' });

    svc.start();
    svc.push(SELECTOR_BUFFER);
    // First tick observes the selector; second tick (after the
    // stability window) actually fires the POST.
    svc._tickForTest();
    vi.setSystemTime(Date.now() + 1500);
    svc._tickForTest();
    await vi.runAllTicks();
    await svc.stop();

    const awaitingPosts = postSpy.mock.calls.filter((c) =>
      c[0].endsWith(`/api/sessions/sess-abc/awaiting-answer`),
    );
    expect(awaitingPosts.length).toBe(1);
    const body = JSON.parse(awaitingPosts[0][2]);
    expect(body.questionId).toMatch(/[0-9a-f-]{36}/);
    expect(body.prompt).toContain('trust the files');
    expect(body.options).toEqual(['Yes, trust them', 'No, exit']);
  });

  it('drives selectOption when the backend resolves a selector answer', async () => {
    const { svc, log } = makeService();
    let capturedQuestionId = '';
    const postSpy = vi
      .spyOn(_transport, 'post')
      .mockImplementation(async (url: string, _headers, payload: string) => {
        if (url.endsWith('/awaiting-answer')) {
          const body = JSON.parse(payload) as { questionId: string };
          capturedQuestionId = body.questionId;
        }
        return { statusCode: 200, body: '{}' };
      });

    svc.start();
    svc.push(SELECTOR_BUFFER);
    svc._tickForTest();
    vi.setSystemTime(Date.now() + 1500);
    svc._tickForTest();
    await vi.runAllTicks();
    expect(capturedQuestionId).not.toBe('');

    // Now mock the pending-answer GET to return the resolved reply.
    vi.spyOn(_transport, 'get').mockImplementation(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        data: { questionId: capturedQuestionId, answer: 'No, exit', optionIndex: 1 },
      }),
    }));

    // Drive the answer-poll timer (1500 ms cadence).
    await vi.advanceTimersByTimeAsync(1700);

    expect(log.selectOption).toEqual([[1, 0]]);
    expect(log.sendCommand).toEqual([]);
    // Service-level cleanup.
    await svc.stop();
    expect(postSpy).toHaveBeenCalled();
  });

  it('resolves the answer label against the options when the backend omits optionIndex', async () => {
    const { svc, log } = makeService();
    let capturedQuestionId = '';
    vi.spyOn(_transport, 'post').mockImplementation(
      async (url: string, _headers, payload: string) => {
        if (url.endsWith('/awaiting-answer')) {
          capturedQuestionId = (JSON.parse(payload) as { questionId: string }).questionId;
        }
        return { statusCode: 200, body: '{}' };
      },
    );

    svc.start();
    svc.push(SELECTOR_BUFFER);
    svc._tickForTest();
    vi.setSystemTime(Date.now() + 1500);
    svc._tickForTest();
    await vi.runAllTicks();
    expect(capturedQuestionId).not.toBe('');

    vi.spyOn(_transport, 'get').mockImplementation(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        data: { questionId: capturedQuestionId, answer: 'No, exit' },
      }),
    }));

    await vi.advanceTimersByTimeAsync(1700);
    expect(log.selectOption).toEqual([[1, 0]]);
    await svc.stop();
  });

});

// ─── 410 / session-dead handling ──────────────────────────────────────

describe('StreamingEmitterService — session lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('disables the emitter on a 410 from the chunk endpoint', async () => {
    const { svc } = makeService();
    const postSpy = vi
      .spyOn(_transport, 'post')
      .mockResolvedValue({ statusCode: 410, body: 'gone' });

    svc.start();
    svc.push('Some agent text here.\n');
    svc._tickForTest();
    await vi.runAllTicks();

    expect(postSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

    // Subsequent pushes + ticks should not emit further POSTs (the
    // emitter went into a stopped state on the 410).
    postSpy.mockClear();
    svc.push('More text that should not ship.\n');
    svc._tickForTest();
    await vi.runAllTicks();
    expect(postSpy.mock.calls.length).toBe(0);
  });

  it('stop() is idempotent', async () => {
    const { svc } = makeService();
    vi.spyOn(_transport, 'post').mockResolvedValue({ statusCode: 200, body: '{}' });
    svc.start();
    await svc.stop();
    await expect(svc.stop()).resolves.toBeUndefined();
  });
});
