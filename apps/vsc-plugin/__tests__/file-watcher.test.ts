import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OutputChannel } from 'vscode';

// The vsc-plugin services import `vscode` at module scope; tests run
// in plain Node, so we provide a minimal stub that's just enough for
// the file-watcher service + AgentStrategyRegistry. `vi.hoisted` is
// required because `vi.mock(...)` is hoisted above top-level
// declarations — accessing module-level consts from inside its
// factory throws "Cannot access X before initialization".
const mocks = vi.hoisted(() => {
  const fnNoOp = () => ({ dispose: () => undefined });
  return {
    onDidSave: fnNoOp,
    onDidCreate: fnNoOp,
    onDidDelete: fnNoOp,
    getWorkspaceFolder: (_uri: { fsPath: string }) => ({
      uri: { fsPath: '/repo', scheme: 'file' },
      name: 'repo',
      index: 0,
    }),
  };
});

vi.mock('vscode', () => {
  return {
    workspace: {
      workspaceFolders: [
        { uri: { fsPath: '/repo', scheme: 'file' }, name: 'repo', index: 0 },
      ],
      onDidSaveTextDocument: mocks.onDidSave,
      onDidCreateFiles: mocks.onDidCreate,
      onDidDeleteFiles: mocks.onDidDelete,
      getWorkspaceFolder: mocks.getWorkspaceFolder,
      getConfiguration: () => ({ get: <T>(_k: string, d: T) => d }),
    },
    Uri: {
      file: (p: string) => ({ fsPath: p, scheme: 'file' }),
    },
    window: {},
  };
});

// Import after the mock so module-level `import * as vscode from 'vscode'`
// resolves to the stub above.
import { parseUnifiedDiff } from '../src/services/file-watcher/diff-parser';
import { _gitDiffSeam, _transport, FileWatcherService } from '../src/services/file-watcher.service';
import { AgentStrategyRegistry } from '../src/services/strategies/AgentStrategyRegistry';

function makeOutputChannel(): OutputChannel {
  const noop = () => undefined;
  const stub: Pick<OutputChannel, 'appendLine' | 'append' | 'name'> & Partial<OutputChannel> = {
    name: 'test',
    append: noop,
    appendLine: noop,
    clear: noop,
    show: noop,
    hide: noop,
    dispose: noop,
    replace: noop,
  };
  return stub as OutputChannel;
}

describe('parseUnifiedDiff', () => {
  test('returns empty result for empty input', () => {
    const out = parseUnifiedDiff('');
    expect(out.hunks).toHaveLength(0);
    expect(out.totalLinesAdded).toBe(0);
    expect(out.totalLinesRemoved).toBe(0);
    expect(out.fileStatus).toBe('modified');
  });

  test('detects added files via new file mode preamble', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      'new file mode 100644',
      'index 0000000..abc1234',
      '--- /dev/null',
      '+++ b/foo.ts',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
    ].join('\n');
    const out = parseUnifiedDiff(diff);
    expect(out.fileStatus).toBe('added');
    expect(out.hunks).toHaveLength(1);
    expect(out.totalLinesAdded).toBe(2);
    expect(out.totalLinesRemoved).toBe(0);
  });

  test('parses mixed-content hunk with context, add, remove', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      'index 1111111..2222222 100644',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -10,3 +10,3 @@',
      ' ctx',
      '-old',
      '+new',
    ].join('\n');
    const out = parseUnifiedDiff(diff);
    expect(out.fileStatus).toBe('modified');
    expect(out.hunks).toHaveLength(1);
    expect(out.totalLinesAdded).toBe(1);
    expect(out.totalLinesRemoved).toBe(1);
    expect(out.hunks[0].lines.map((l) => l.type)).toEqual(['context', 'remove', 'add']);
  });
});

describe('FileWatcherService — agent-activity gate', () => {
  let svc: FileWatcherService;
  let postSpy: ReturnType<typeof vi.spyOn>;
  let gitDiffSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Default: agent has NOT run recently. Tests opt in by pinning ts.
    AgentStrategyRegistry.getInstance(makeOutputChannel())._setLastAgentActivityTsForTest(0);

    svc = new FileWatcherService({
      sessionId: 'sess-1234',
      pluginId: 'plug-1',
      pluginAuthToken: 'tok-1',
      apiBaseUrl: 'http://test.invalid',
      log: makeOutputChannel(),
    });
    svc.start();

    postSpy = vi.spyOn(_transport, 'post').mockResolvedValue({ statusCode: 200, body: '' });
    gitDiffSpy = vi.spyOn(_gitDiffSeam, 'run').mockResolvedValue(
      [
        'diff --git a/foo.ts b/foo.ts',
        'index 1111111..2222222 100644',
        '--- a/foo.ts',
        '+++ b/foo.ts',
        '@@ -1,1 +1,1 @@',
        '-old',
        '+new',
      ].join('\n'),
    );
  });

  afterEach(() => {
    svc.stop();
    postSpy.mockRestore();
    gitDiffSpy.mockRestore();
  });

  test('drops events when no agent has run recently', async () => {
    svc._scheduleForTest('/repo/foo.ts', 'change');
    // Wait past the 250 ms debounce + a tick for the async emit.
    await new Promise((r) => setTimeout(r, 350));
    expect(gitDiffSpy).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });

  test('emits files-changed + review-hunks when an agent ran in the last 60 s', async () => {
    AgentStrategyRegistry.getInstance(makeOutputChannel())._setLastAgentActivityTsForTest(
      Date.now() - 5_000,
    );

    svc._scheduleForTest('/repo/foo.ts', 'change');
    await new Promise((r) => setTimeout(r, 350));

    // One files-changed POST + one review-hunks POST (the diff has 1 hunk).
    expect(postSpy).toHaveBeenCalledTimes(2);
    const urls = postSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(urls).toContain('http://test.invalid/api/files/changed');
    expect(urls).toContain('http://test.invalid/api/review/hunks');
  });
});
