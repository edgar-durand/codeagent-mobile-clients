/**
 * Reply-language hint: the app's device locale on `start_task` becomes one
 * context line on the agent's first turn, so a non-English user doesn't spend
 * a FREE task stating their language (replays 2026-10-05: tchacker647,
 * info.notifikasi.transaksi).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpPublisher } from '../../src/agents/acp/publisher';
import { StreamingState, handleCommand } from '../../src/agents/acp/runner';
import {
  _resetReplyLanguageHints,
  replyLanguageContextOnce,
  replyLanguageName,
} from '../../src/agents/acp/reply-language';
import { SQUAD_CONTEXT_URI } from '../../src/agents/acp/squad-context';
import type { PromptBlock } from '../../src/agents/acp/buildAcpPromptBlocks';

vi.mock('../../src/services/pairing.service', () => ({
  postTurnEvent: vi.fn().mockResolvedValue(undefined),
  fetchCurrentPluginAuthToken: vi.fn(),
  _postJsonAuthed: vi.fn(),
}));

beforeEach(() => _resetReplyLanguageHints());

describe('replyLanguageName', () => {
  it('names the language of a BCP-47 locale', () => {
    expect(replyLanguageName('es-CO')).toBe('Spanish');
    expect(replyLanguageName('id-ID')).toBe('Indonesian');
    expect(replyLanguageName('pt_BR')).toBe('Portuguese');
  });

  it('adds nothing for English, a missing tag or garbage', () => {
    expect(replyLanguageName('en-US')).toBeNull();
    expect(replyLanguageName(undefined)).toBeNull();
    expect(replyLanguageName('')).toBeNull();
    expect(replyLanguageName('!!')).toBeNull();
  });
});

describe('replyLanguageContextOnce', () => {
  it('returns the instruction once per (session, agent)', () => {
    const line = replyLanguageContextOnce('es-CO', 's1', 'codex');
    expect(line).toBe(
      "The user's device language is Spanish. Reply in Spanish unless the user writes in another language.",
    );
    expect(replyLanguageContextOnce('es-CO', 's1', 'codex')).toBeNull();
    // A switched-to agent in the same session gets it on ITS first turn.
    expect(replyLanguageContextOnce('es-CO', 's1', 'claude')).not.toBeNull();
  });
});

describe('start_task with a locale', () => {
  afterEach(() => vi.restoreAllMocks());

  function makeHarness() {
    const publisher = new AcpPublisher({
      sessionId: 'sess-lang',
      pluginId: 'plugin-lang',
      pluginAuthToken: 'tok',
      apiBaseUrl: 'https://api.example.test',
    });
    vi.spyOn(publisher, 'publishOutput').mockResolvedValue(undefined);
    vi.spyOn(publisher, 'publishStreamingChunk').mockResolvedValue(undefined);
    vi.spyOn(publisher, 'pushConversation').mockResolvedValue(undefined);
    vi.spyOn(publisher, 'pushSessionList').mockResolvedValue(undefined);
    const streaming = new StreamingState(publisher);
    const prompts: PromptBlock[][] = [];
    const client = {
      prompt: vi.fn(async (blocks: PromptBlock[]) => {
        prompts.push([...blocks]);
        streaming.append({ chunkId: `m-${prompts.length}`, kind: 'text', delta: 'Hola.' });
        return { stopReason: 'end_turn' as const };
      }),
      cancel: vi.fn(async () => undefined),
    };
    const appendUserPrompt = vi.fn();
    const run = (id: string, payload: Record<string, unknown>) =>
      handleCommand(
        { id, type: 'start_task', payload } as never,
        client as never,
        { sendResult: vi.fn(async () => undefined) } as never,
        'acp-sess-lang',
        streaming,
        {
          agent: 'claude',
          sessionId: 'sess-lang',
          pluginId: 'plugin-lang',
          pluginAuthToken: 'tok',
          adapter: { command: 'noop', args: [] },
          cwd: '/tmp',
        } as never,
        { appendUserPrompt, appendAgentReply: vi.fn(), flush: vi.fn(async () => undefined) } as never,
        { uploadConversationIfChanged: vi.fn(async () => undefined) } as never,
        undefined,
        { flushTurn: vi.fn(async () => undefined) } as never,
        () => null,
        publisher,
        [],
      );
    return { run, prompts, appendUserPrompt };
  }

  const contextText = (blocks: PromptBlock[]): string | null => {
    const b = blocks.find((x) => x.type === 'resource');
    return b && b.type === 'resource' && b.resource.uri === SQUAD_CONTEXT_URI
      ? (b.resource.text ?? null)
      : null;
  };

  it('the first turn carries the language as context — never in the user prompt — and later turns do not', async () => {
    const { run, prompts, appendUserPrompt } = makeHarness();
    await run('c1', { prompt: 'hola', locale: 'es-CO' });
    await run('c2', { prompt: 'gracias', locale: 'es-CO' });

    expect(contextText(prompts[0])).toContain('Reply in Spanish');
    expect(contextText(prompts[1])).toBeNull();
    // The user's own words are what gets recorded / shown.
    expect(appendUserPrompt).toHaveBeenNthCalledWith(1, 'hola');
  });

  it('no locale (older app) → no context block', async () => {
    const { run, prompts } = makeHarness();
    await run('c1', { prompt: 'hello' });
    expect(contextText(prompts[0])).toBeNull();
  });
});
