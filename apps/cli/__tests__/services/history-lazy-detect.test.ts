import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock os.homedir BEFORE importing HistoryService — the module
// resolves the projects-root via os.homedir() at projectDir-getter
// time, but vi.mock takes effect at import. Using a module factory
// keeps both the spied homedir and any other os exports available.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: vi.fn(() => process.env.HOME ?? actual.homedir()),
  };
});

import { HistoryService } from '../../src/services/history.service';
import { resolveHistoryDir } from '../../src/agents/claude/history';
import type { RuntimeStrategy } from '../../src/agents/strategy';

/**
 * Minimal RuntimeStrategy stub for tests. resolveHistoryDir delegates
 * to the real claude/history implementation via os.homedir (which is
 * already mocked above), so the birthtime-filter tests remain hermetic.
 */
function makeTestRuntime(_cwd: string): RuntimeStrategy {
  return {
    id: 'claude',
    meta: {} as RuntimeStrategy['meta'],
    resolveHistoryDir: (c: string) => resolveHistoryDir(c),
    parseHistoryFile: () => [],
    getCurrentUsage: () => null,
    fetchWeeklyUsage: async () => null,
    prepareLaunch: async () => ({ cmd: 'claude', args: [] }),
    resumeLaunchArgs: () => [],
    listModels: async () => [],
    changeModelInstruction: () => ({ type: 'pty', ptyInput: '' }),
    summarizeInstruction: () => ({ ptyInput: '' }),
  } as unknown as RuntimeStrategy;
}

/**
 * Regression: codespaces vs local CLI rendering parity.
 *
 * In codespaces, Anthropic's `claude` launcher lazy-downloads node 16
 * on the first interactive invocation (~30-60s). That meant the JSONL
 * file the CLI watches doesn't exist yet at start.ts's eager
 * detectCurrentConversation() call (T+2000ms), so currentConversationId
 * stayed null forever. Every subsequent uploadDelta() then early-bailed
 * and the server never received the canonical markdown — mobile/web
 * rendered the streaming-text approximation (no ``` fences) instead of
 * a CodeBlock.
 *
 * The fix: when uploadDelta is the first path that needs the
 * conversation id, detect it then. These tests pin both the eager-detect
 * behaviour AND the lazy-detect fallback so the codespace regression
 * can't sneak back in.
 */
describe('HistoryService — lazy detect on uploadDelta', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  // Pretend we're inside a codespace working dir.
  const cwd = '/workspaces/test-repo';

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-history-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function encodedProjectDir(): string {
    // Mirror history.service's encodeCwd: replace [/\\:] with `-`.
    const encoded = cwd.replace(/[/\\:]/g, '-');
    return path.join(tmpHome, '.claude', 'projects', encoded);
  }

  function writeJsonl(uuid: string, lines: string[]): void {
    const dir = encodedProjectDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${uuid}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
  }

  it('uploadDelta returns 0 when no conversation id is detectable yet', async () => {
    // Empty home — no JSONL anywhere. detectCurrentConversation will
    // fail to find a file. uploadDelta must return 0 cleanly without
    // throwing.
    const svc = new HistoryService(makeTestRuntime(cwd), 'plg-1', cwd);
    expect(svc.getCurrentConversationId()).toBeNull();
    const sent = await svc.uploadDelta();
    expect(sent).toBe(0);
    // Lazy-detect ran, found nothing, conversation id is still null.
    expect(svc.getCurrentConversationId()).toBeNull();
  });

  // Bumped from the default 5 s because `uploadDelta` calls the
  // private `post()` helper which uses raw `https.request` with a
  // 15 s socket timeout. The test's `vi.fn(global.fetch)` mock
  // doesn't intercept raw https calls — so on CI runners where
  // DNS or network is slow, the post hangs until the 15 s socket
  // timeout fires. The assertion we care about (`currentConversationId`
  // becomes set) happens BEFORE the post returns, so we don't
  // depend on the post completing successfully — we just need to
  // give the post enough budget to complete or time out. 20 s
  // covers the helper's 15 s socket timeout + slack.
  it('uploadDelta lazy-detects a JSONL that landed AFTER construction', async () => {
    const svc = new HistoryService(makeTestRuntime(cwd), 'plg-1', cwd);
    expect(svc.getCurrentConversationId()).toBeNull();

    // Simulate: claude finally finished bootstrapping (post-T+2000ms)
    // and wrote its first JSONL. Eager detect already ran and found
    // nothing — the lazy path inside uploadDelta is the only thing
    // that can pick this up.
    const uuid = '11111111-2222-3333-4444-555555555555';
    writeJsonl(uuid, [
      JSON.stringify({
        type: 'user',
        uuid: 'msg-1',
        timestamp: Date.now(),
        message: { content: 'hello' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'msg-2',
        timestamp: Date.now() + 1,
        message: { content: '```ts\nfoo()\n```' },
      }),
    ]);

    // Stub the network so the test stays hermetic. The post helper is
    // a private import, but since uploadDelta uses fetch under the hood
    // we mock global fetch just in case; simpler: assert the side-effect
    // we care about (conversation id became set).
    const originalFetch = global.fetch;
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) }) as never,
    );
    try {
      await svc.uploadDelta();
    } finally {
      global.fetch = originalFetch;
    }

    expect(svc.getCurrentConversationId()).toBe(uuid);
  }, 20_000);

  it('uploadDelta ignores a JSONL that existed BEFORE the CLI started (parallel Claude session in the same project dir)', async () => {
    // Repro for: user runs `codeam pair` in a project where a
    // separate Claude Code session is already chatting. The other
    // session's JSONL is being actively written, so a naive
    // mtime sort picks it as the "current" conversation and the
    // CLI uploads that other run's chat to the API — mobile auto-
    // loads it as if it were the fresh pair's content.
    //
    // The fix filters detect-by-mtime through `birthtime >=
    // bootTimeMs - grace`, so JSONLs that already existed in the
    // dir before this CLI's HistoryService was constructed are
    // ineligible regardless of how hot their mtime is.
    const parallelUuid = '99999999-aaaa-bbbb-cccc-dddddddddddd';
    writeJsonl(parallelUuid, [
      JSON.stringify({
        type: 'user',
        uuid: 'parallel-1',
        timestamp: Date.now() - 1_000,
        message: { content: 'leaking parallel chat' },
      }),
    ]);

    const svc = new HistoryService(makeTestRuntime(cwd), 'plg-1', cwd, { bootTimeMs: Date.now() + 60_000 });
    expect(svc.getCurrentConversationId()).toBeNull();

    const filePath = path.join(encodedProjectDir(), `${parallelUuid}.jsonl`);
    const now = Date.now() / 1000;
    fs.utimesSync(filePath, now, now);

    const originalFetch = global.fetch;
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) }) as never,
    );
    try {
      await svc.uploadDelta();
    } finally {
      global.fetch = originalFetch;
    }

    expect(svc.getCurrentConversationId()).toBeNull();
  });

  it('uploadDelta is a no-op when conversation id is already set and JSONL is up to date', async () => {
    const uuid = 'aaaa-bbbb';
    writeJsonl(uuid, [
      JSON.stringify({
        type: 'user',
        uuid: 'msg-1',
        timestamp: Date.now(),
        message: { content: 'hi' },
      }),
    ]);

    const svc = new HistoryService(makeTestRuntime(cwd), 'plg-1', cwd);
    svc.setCurrentConversationId(uuid);
    expect(svc.getCurrentConversationId()).toBe(uuid);

    // The lazy-detect path must NOT clobber an already-set
    // conversation id even if the projects dir has multiple files.
    writeJsonl('zzzz-other', [
      JSON.stringify({ type: 'user', uuid: 'm-x', timestamp: 1, message: { content: 'x' } }),
    ]);

    const originalFetch = global.fetch;
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) }) as never,
    );
    try {
      await svc.uploadDelta();
    } finally {
      global.fetch = originalFetch;
    }
    expect(svc.getCurrentConversationId()).toBe(uuid);
  });
});
