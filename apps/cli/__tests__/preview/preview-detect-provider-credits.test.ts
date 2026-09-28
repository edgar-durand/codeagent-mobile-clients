/**
 * Preview detection on an agent whose provider is out of credits says so,
 * instead of "Detection Failed — the agent didn't return anything".
 *
 * Web replay 2026-09-27 (OpenRouter-backed agent): the detect one-shot failed
 * with OpenRouter's 402 "requires more credits", but `claude -p` prints that on
 * STDOUT and exits 1, `spawnAndCapture` dropped stdout on a non-zero exit, and
 * the user read a detection error that blamed the project.
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

import { resolvePreviewDetection } from '../../src/commands/start/handlers';
import { resetCurrentAgentEnvForTests, setCurrentAgentEnv } from '../../src/agents/current-agent-env';
import { spawnAndCapture } from '../../src/services/spawn-and-capture';

type Runtime = Parameters<typeof resolvePreviewDetection>[0]['runtime'];
type OneShotOpts = { onStderr?: (c: string) => void; onFailedOutput?: (s: string) => void };

const OPENROUTER_402 =
  'API Error: 402 This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 1416. To increase, visit https://openrouter.ai/settings/keys and create a key with a higher total limit';

let scratch: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockPostPreviewEvent.mockClear();
  scratch = mkdtempSync(path.join(tmpdir(), 'preview-credits-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(scratch);
  setCurrentAgentEnv({ ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1', ANTHROPIC_AUTH_TOKEN: undefined });
});

afterEach(() => {
  cwdSpy.mockRestore();
  resetCurrentAgentEnvForTests();
  rmSync(scratch, { recursive: true, force: true });
});

function previewErrorMessage(): string | undefined {
  const call = mockPostPreviewEvent.mock.calls
    .map((c) => c[0] as { type: string; payload?: { message?: string } })
    .find((a) => a.type === 'preview_error');
  return call?.payload?.message;
}

async function detectWith(generateOneShot: (p: string, o: OneShotOpts) => Promise<string | null>) {
  const detection = await resolvePreviewDetection({
    ctx: { sessionId: 'sess-1', pluginId: 'plug-1' },
    runtime: { id: 'claude', generateOneShot } as unknown as Runtime,
    pluginAuthToken: 'tok-1',
  });
  expect(detection).toBeNull();
  await vi.waitFor(() => expect(previewErrorMessage()).toBeDefined());
  return previewErrorMessage()!;
}

describe('preview detection — provider out of credits', () => {
  it('the 402 on the failed one-shot STDOUT → "out of credits", not a detection error', async () => {
    const message = await detectWith(async (_p, o) => {
      o.onFailedOutput?.(OPENROUTER_402);
      return null;
    });
    expect(message).toBe(
      "Preview detection couldn't run — your OpenRouter account has no credits left. " +
        'Top up at your provider, or switch this session to another agent.',
    );
    expect(message).not.toMatch(/didn't return anything|JSON|ERR_MANIFEST_INVALID/);
  });

  it('the same error on stderr is classified too', async () => {
    const message = await detectWith(async (_p, o) => {
      o.onStderr?.(`${OPENROUTER_402}\n`);
      return null;
    });
    expect(message).toContain('your OpenRouter account has no credits left');
  });

  it('a one-shot that exits 0 with the error as its "answer" is classified too', async () => {
    const message = await detectWith(async () => OPENROUTER_402);
    expect(message).toContain('no credits left');
  });

  it('on the house rail it is NOT blamed on the user\'s provider', async () => {
    setCurrentAgentEnv({
      ANTHROPIC_BASE_URL: 'https://api.codeagent-mobile.com/api/v1/agent-proxy',
      ANTHROPIC_AUTH_TOKEN: 'house-tok',
    });
    const message = await detectWith(async (_p, o) => {
      o.onFailedOutput?.(OPENROUTER_402);
      return null;
    });
    expect(message).not.toContain('no credits left');
  });

  it('an empty failure with no billing signal keeps the existing copy', async () => {
    const message = await detectWith(async () => null);
    expect(message).toContain("didn't return anything");
  });
});

describe('spawnAndCapture — stdout of a failed one-shot', () => {
  it('hands it to onFailedOutput and still resolves null', async () => {
    const onFailedOutput = vi.fn();
    const out = await spawnAndCapture(
      process.execPath,
      ['-e', 'process.stdout.write("API Error: 402 requires more credits"); process.exit(1)'],
      { timeoutMs: 10_000, onFailedOutput, env: process.env },
    );
    expect(out).toBeNull();
    expect(onFailedOutput).toHaveBeenCalledWith('API Error: 402 requires more credits');
  });

  it('does not call it on success', async () => {
    const onFailedOutput = vi.fn();
    const out = await spawnAndCapture(process.execPath, ['-e', 'process.stdout.write("ok")'], {
      timeoutMs: 10_000,
      onFailedOutput,
      env: process.env,
    });
    expect(out).toBe('ok');
    expect(onFailedOutput).not.toHaveBeenCalled();
  });
});
