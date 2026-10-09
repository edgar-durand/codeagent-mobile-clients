/**
 * Every detection `preview_error` says WHY (codeagent-qrk1) and a managed-wallet
 * 402 is typed `CREDITS_EXHAUSTED` so the apps route to top-up (codeagent-oyic).
 *
 * qrk1: one user chained five detection failures in 19 minutes (2026-08-30) and
 * PostHog only had `stage` — the classification (`describeDetectionFailure`)
 * stayed in the box's local debug log, so the cause was unrecoverable.
 * oyic: a FREE codespace on a managed agent with a $0 wallet got the agent-proxy
 * 402 on the detect one-shot; the app showed "Detection Failed / Try again" and
 * the retry hit the same 402 (RCA 2026-10-04).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

import { PREVIEW_DETECT_TIMEOUT_MS, resolvePreviewDetection } from '../../src/commands/start/handlers';
import { resetCurrentAgentEnvForTests, setCurrentAgentEnv } from '../../src/agents/current-agent-env';
import { looksLikeManagedCreditsExhausted } from '../../src/services/preview/parser';

type Runtime = Parameters<typeof resolvePreviewDetection>[0]['runtime'];
type OneShotOpts = { onStderr?: (c: string) => void; onFailedOutput?: (s: string) => void };
type ErrorPayload = { stage?: string; message?: string; reason?: string; code?: string; agent?: string };

/** The agent-proxy's prepaid-gate refusal, as Claude Code relays it. */
const MANAGED_402_JSON =
  'API Error: 402 {"code":"CREDITS_EXHAUSTED","message":"You\'re out of credits — top up to keep this agent running."}';
const MANAGED_402_TEXT = "API Error: 402 You're out of credits — top up to keep this agent running.";
const OPENROUTER_402 =
  'API Error: 402 This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 1416.';

let scratch: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockPostPreviewEvent.mockClear();
  scratch = mkdtempSync(path.join(tmpdir(), 'preview-reason-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(scratch);
});

afterEach(() => {
  cwdSpy.mockRestore();
  resetCurrentAgentEnvForTests();
  rmSync(scratch, { recursive: true, force: true });
});

function errorPayload(): ErrorPayload | undefined {
  return mockPostPreviewEvent.mock.calls
    .map((c) => c[0] as { type: string; payload?: ErrorPayload })
    .find((a) => a.type === 'preview_error')?.payload;
}

async function detectWith(
  generateOneShot: ((p: string, o: OneShotOpts) => Promise<string | null>) | undefined,
  id = 'claude',
): Promise<ErrorPayload> {
  const detection = await resolvePreviewDetection({
    ctx: { sessionId: 'sess-1', pluginId: 'plug-1' },
    runtime: { id, generateOneShot } as unknown as Runtime,
    pluginAuthToken: 'tok-1',
  });
  expect(detection).toBeNull();
  await vi.waitFor(() => expect(errorPayload()).toBeDefined());
  return errorPayload()!;
}

describe('preview detection — managed wallet out of credits (codeagent-oyic)', () => {
  beforeEach(() => {
    setCurrentAgentEnv({
      ANTHROPIC_BASE_URL: 'https://api.codeagent-mobile.com/api/v1/agent-proxy',
      ANTHROPIC_AUTH_TOKEN: 'house-tok',
    });
  });

  it('the proxy 402 JSON body on stderr → code CREDITS_EXHAUSTED', async () => {
    const p = await detectWith(async (_p, o) => {
      o.onStderr?.(`${MANAGED_402_JSON}\n`);
      return null;
    });
    expect(p.code).toBe('CREDITS_EXHAUSTED');
    expect(p.reason).toBe('credits_exhausted');
    expect(p.stage).toBe('detection');
    expect(p.message).toMatch(/out of credits/i);
  });

  it('the relayed sentence on the failed STDOUT → code CREDITS_EXHAUSTED', async () => {
    const p = await detectWith(async (_p, o) => {
      o.onFailedOutput?.(MANAGED_402_TEXT);
      return null;
    });
    expect(p.code).toBe('CREDITS_EXHAUSTED');
  });

  it('a BYO provider 402 is NOT tagged CREDITS_EXHAUSTED', async () => {
    setCurrentAgentEnv({ ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1', ANTHROPIC_AUTH_TOKEN: undefined });
    const p = await detectWith(async (_p, o) => {
      o.onFailedOutput?.(OPENROUTER_402);
      return null;
    });
    expect(p.code).toBeUndefined();
    expect(p.reason).toBe('provider_credits');
  });

  it('classifier is keyed on our code / sentence only', () => {
    expect(looksLikeManagedCreditsExhausted(MANAGED_402_JSON)).toBe(true);
    expect(looksLikeManagedCreditsExhausted(MANAGED_402_TEXT)).toBe(true);
    expect(looksLikeManagedCreditsExhausted(OPENROUTER_402)).toBe(false);
    expect(looksLikeManagedCreditsExhausted('API Error: 402 Insufficient credits')).toBe(false);
  });
});

describe('preview detection — every error carries a reason + agent (codeagent-qrk1)', () => {
  it.each([
    ['no_output', null],
    ['no_json', 'I think this is a Next.js app.'],
    ['missing_fields', '{"framework":"next"}'],
    ['unsupported', '{"framework":"unsupported","notes":"library"}'],
  ] as const)('%s', async (reason, answer) => {
    const p = await detectWith(async () => answer, 'codex');
    expect(p.reason).toBe(reason);
    expect(p.agent).toBe('codex');
    expect(p.code).toBeUndefined();
  });

  it('no_oneshot — a runtime without generateOneShot', async () => {
    const p = await detectWith(undefined, 'aider');
    expect(p.reason).toBe('no_oneshot');
    expect(p.agent).toBe('aider');
  });

  it('timeout — the one-shot never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // The deadline timer is armed right before the one-shot is invoked, after
      // real fs reads — advance only once the one-shot has actually started.
      let started!: () => void;
      const oneShotStarted = new Promise<void>((r) => (started = r));
      const pending = resolvePreviewDetection({
        ctx: { sessionId: 'sess-1', pluginId: 'plug-1' },
        runtime: {
          id: 'claude',
          generateOneShot: () => {
            started();
            return new Promise<string | null>(() => undefined);
          },
        } as unknown as Runtime,
        pluginAuthToken: 'tok-1',
      });
      await oneShotStarted;
      await vi.advanceTimersByTimeAsync(PREVIEW_DETECT_TIMEOUT_MS + 1);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(errorPayload()).toBeDefined());
    expect(errorPayload()!.reason).toBe('timeout');
  });

  it('never leaks the raw agent output into the payload', async () => {
    const secretish = 'I think this is a Next.js app. sk-live-abc';
    const p = await detectWith(async () => secretish);
    expect(JSON.stringify(p)).not.toContain('sk-live-abc');
  });
});
