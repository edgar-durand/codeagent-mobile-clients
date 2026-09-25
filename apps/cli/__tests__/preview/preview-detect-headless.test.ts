/**
 * Project detection is HEADLESS-ONLY and always ENDS.
 *
 * 2026-09-23 (nightly triage, JetBrains user, local Codex session, C++ JUCE
 * project): the internal `PREVIEW_DETECT_PROMPT` ("OUTPUT JSON ONLY…") showed
 * up in the session chat as a big USER message followed by Codex's raw JSON,
 * and the preview pane sat on "Detecting project…" for 13-36 minutes after
 * Codex had answered `framework:"unsupported"`.
 *
 * The prompt reached the chat through the baton's Codex discovery binding to
 * the `codex exec` one-shot rollout (covered in codex.history.test.ts). This
 * suite pins the HANDLER-side contract on every dispatch path — legacy PTY,
 * ACP (`buildLegacyContextForACP` → base ctx), and the baton's LOCAL_DRIVE
 * (`NativeTuiDriver.dispatch` → the same `dispatchCommand`):
 *
 *   1. the detect prompt goes ONLY to `generateOneShot` — never to the live
 *      agent (`agent.write`) nor the output pipe;
 *   2. an `unsupported` answer produces a terminal `preview_error`;
 *   3. detection is bounded by `PREVIEW_DETECT_TIMEOUT_MS`, and a result that
 *      arrives after the deadline is dropped instead of resurrecting the sheet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PREVIEW_DETECT_PROMPT } from '@codeam/shared';

const { mockPostPreviewEvent } = vi.hoisted(() => ({
  mockPostPreviewEvent: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../src/services/pairing.service', () => ({
  postLinkCredential: vi.fn().mockResolvedValue(undefined),
  postAiResult: vi.fn().mockResolvedValue(undefined),
  postPreviewEvent: mockPostPreviewEvent,
  postBeadsEvent: vi.fn().mockResolvedValue(undefined),
  postCliUpdateEvent: vi.fn().mockResolvedValue(undefined),
  postCoderabbitEvent: vi.fn().mockResolvedValue(undefined),
  postAgentReviewReport: vi.fn().mockResolvedValue(undefined),
  fetchProvisionCredential: vi.fn().mockResolvedValue(undefined),
}));

import {
  dispatchCommand,
  PREVIEW_DETECT_TIMEOUT_MS,
  type BaseHandlerContext,
  type HandlerContext,
} from '../../src/commands/start/handlers';
import type { RuntimeStrategy } from '../../src/agents/strategy';
import type { RemoteCommand } from '../../src/services/command-relay.service';

const UNSUPPORTED_ANSWER = JSON.stringify({
  framework: 'unsupported',
  notes: 'C++ JUCE audio plugin — no dev server applies.',
});

const cmd: RemoteCommand = {
  id: 'cmd-1',
  sessionId: 'sess-1',
  type: 'request_preview_detect',
  payload: {},
};

/** The live-agent surfaces a leaked prompt would have to go through. */
function makeAgent() {
  return { write: vi.fn(), sendPrompt: vi.fn(), restart: vi.fn() };
}

/**
 * The context the baton's `NativeTuiDriver.dispatch` (LOCAL_DRIVE) and the
 * legacy PTY `start()` build — full PTY fields, so a handler that reached for
 * the live agent COULD.
 */
function makePtyCtx(
  runtime: Pick<RuntimeStrategy, 'id'> & Partial<Pick<RuntimeStrategy, 'generateOneShot'>>,
  agent: ReturnType<typeof makeAgent>,
): HandlerContext {
  return {
    outputSvc: { push: vi.fn() } as unknown as HandlerContext['outputSvc'],
    agent: agent as unknown as HandlerContext['agent'],
    historySvc: {} as HandlerContext['historySvc'],
    relay: {
      sendResult: vi.fn().mockResolvedValue(undefined),
    } as unknown as HandlerContext['relay'],
    runtime: runtime as HandlerContext['runtime'],
    setKeepAlive: vi.fn(),
    keepAliveCtx: { inCodespace: false } as HandlerContext['keepAliveCtx'],
    pluginId: 'plug-1',
    sessionId: 'sess-1',
    agentId: 'codex',
    pluginAuthToken: 'tok-1',
    beads: null,
  };
}

/** The base-only context the ACP runner hands the legacy registry. */
function makeAcpCtx(
  runtime: Pick<RuntimeStrategy, 'id'> & Partial<Pick<RuntimeStrategy, 'generateOneShot'>>,
): BaseHandlerContext {
  return {
    runtime: runtime as BaseHandlerContext['runtime'],
    relay: {
      sendResult: vi.fn().mockResolvedValue(undefined),
    } as unknown as BaseHandlerContext['relay'],
    pluginId: 'plug-1',
    sessionId: 'sess-1',
    agentId: 'codex',
    pluginAuthToken: 'tok-1',
  };
}

/**
 * Yield to libuv's poll phase until `until()` holds — the handler awaits real
 * fs I/O (`readPreviewConfig`) before it starts the one-shot, and a faked
 * `setTimeout` can't advance THAT. Only `setTimeout`/`clearTimeout` are faked
 * in the timeout test, so `setImmediate` stays real here. Bounded.
 */
async function flushIoUntil(until: () => boolean): Promise<void> {
  for (let i = 0; i < 1_000 && !until(); i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(until()).toBe(true);
}

function postedTypes(): string[] {
  return mockPostPreviewEvent.mock.calls.map((c) => (c[0] as { type: string }).type);
}

function lastPosted(type: string): Record<string, unknown> | undefined {
  return mockPostPreviewEvent.mock.calls
    .map((c) => c[0] as { type: string; payload?: Record<string, unknown> })
    .reverse()
    .find((a) => a.type === type)?.payload;
}

// The handler reads `.codeam/preview.json` from process.cwd(); point it at an
// empty temp dir so a developer's own override can't short-circuit the agent.
let scratch: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockPostPreviewEvent.mockClear();
  scratch = mkdtempSync(path.join(tmpdir(), 'preview-detect-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(scratch);
});

afterEach(() => {
  cwdSpy.mockRestore();
  vi.useRealTimers();
  rmSync(scratch, { recursive: true, force: true });
});

describe('request_preview_detect — headless one-shot only, always terminal', () => {
  it('sends the detect prompt ONLY to generateOneShot, never to the live agent (PTY/baton ctx)', async () => {
    const agent = makeAgent();
    const generateOneShot = vi.fn().mockResolvedValue(UNSUPPORTED_ANSWER);

    await dispatchCommand(makePtyCtx({ id: 'codex', generateOneShot }, agent), cmd);
    await vi.waitFor(() => expect(postedTypes()).toContain('preview_error'));

    expect(generateOneShot).toHaveBeenCalledTimes(1);
    expect(generateOneShot).toHaveBeenCalledWith(
      PREVIEW_DETECT_PROMPT,
      expect.objectContaining({ timeoutMs: PREVIEW_DETECT_TIMEOUT_MS }),
    );
    expect(agent.write).not.toHaveBeenCalled();
    expect(agent.sendPrompt).not.toHaveBeenCalled();
  });

  it('an `unsupported` answer ends detection with preview_error{stage:unsupported} carrying the reason', async () => {
    const generateOneShot = vi.fn().mockResolvedValue(UNSUPPORTED_ANSWER);

    await dispatchCommand(makePtyCtx({ id: 'codex', generateOneShot }, makeAgent()), cmd);
    await vi.waitFor(() => expect(postedTypes()).toContain('preview_error'));

    expect(postedTypes()).toEqual(['preview_detection_pending', 'preview_error']);
    expect(lastPosted('preview_error')).toMatchObject({
      stage: 'unsupported',
      message: 'C++ JUCE audio plugin — no dev server applies.',
    });
  });

  it('…and on the ACP path too (base-only context, as buildLegacyContextForACP builds it)', async () => {
    const generateOneShot = vi.fn().mockResolvedValue(UNSUPPORTED_ANSWER);

    await dispatchCommand(makeAcpCtx({ id: 'codex', generateOneShot }), cmd);
    await vi.waitFor(() => expect(postedTypes()).toContain('preview_error'));

    expect(generateOneShot).toHaveBeenCalledWith(
      PREVIEW_DETECT_PROMPT,
      expect.objectContaining({ timeoutMs: PREVIEW_DETECT_TIMEOUT_MS }),
    );
    expect(lastPosted('preview_error')).toMatchObject({ stage: 'unsupported' });
  });

  it('a runtime without a one-shot gets preview_error, not a prompt through the chat', async () => {
    const agent = makeAgent();

    await dispatchCommand(makePtyCtx({ id: 'aider' }, agent), cmd);
    await vi.waitFor(() => expect(postedTypes()).toContain('preview_error'));

    expect(agent.write).not.toHaveBeenCalled();
    expect(lastPosted('preview_error')).toMatchObject({
      stage: 'detection',
      message: expect.stringContaining("Preview detection isn't available on aider sessions yet"),
    });
  });

  it(`times out after PREVIEW_DETECT_TIMEOUT_MS with a clear preview_error and drops a late answer`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let resolveLate: (v: string) => void = () => {};
    const generateOneShot = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveLate = resolve;
        }),
    );

    await dispatchCommand(makePtyCtx({ id: 'codex', generateOneShot }, makeAgent()), cmd);
    // Let readPreviewConfig (fs, not timer-based) settle and the one-shot start.
    await flushIoUntil(() => generateOneShot.mock.calls.length === 1);

    await vi.advanceTimersByTimeAsync(PREVIEW_DETECT_TIMEOUT_MS - 1);
    await flushIoUntil(() => postedTypes().includes('preview_detection_pending'));
    expect(postedTypes()).not.toContain('preview_error');

    await vi.advanceTimersByTimeAsync(1);
    await flushIoUntil(() => postedTypes().includes('preview_error'));
    expect(postedTypes()).toEqual(['preview_detection_pending', 'preview_error']);
    expect(lastPosted('preview_error')).toMatchObject({
      stage: 'detection',
      message: expect.stringContaining('timed out after 120 s'),
    });

    // The agent finally answers with a perfectly valid detection — too late.
    resolveLate(
      JSON.stringify({
        framework: 'vite',
        command: 'npm',
        args: ['run', 'dev'],
        port: 5173,
        ready_pattern: 'Local:',
      }),
    );
    for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(postedTypes()).not.toContain('preview_detection_ready');
  });
});
