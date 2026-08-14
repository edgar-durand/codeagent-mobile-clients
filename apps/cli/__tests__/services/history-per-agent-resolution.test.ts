/**
 * Per-agent transcript resolution in HistoryService.
 *
 * THE BUG: resume / `get_conversation` showed an EMPTY conversation for Codex.
 * HistoryService read transcripts only from the Claude layout
 * (`<projectDir>/<sessionId>.jsonl` parsed by the Claude JSONL parser). Codex
 * stores its transcript in `~/.codex/sessions/.../rollout-*.jsonl` and keys the
 * session id INSIDE the file, so that layout never found it → 0 messages
 * uploaded → empty chat on resume.
 *
 * THE FIX: when the runtime strategy exposes `resolveHistoryFile`, route file
 * resolution + parsing through it (Codex rollouts via `parseHistoryFile`),
 * mapping the shared NormalizedMessage shape onto the wire shape. Claude leaves
 * `resolveHistoryFile` undefined and keeps its existing JSONL path unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HistoryService } from '../../src/services/history.service';
import type { RuntimeStrategy } from '../../src/agents/strategy';

type WireMessage = { id: string; role: 'user' | 'agent'; text: string; timestamp: number };
type WithRead = { readConversation: (id: string) => WireMessage[] };

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-hist-peragent-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('HistoryService — per-agent transcript resolution', () => {
  it('Codex: uploadConversationIfChanged resolves the transcript via the strategy, keyed by (cwd, sessionId)', async () => {
    const rollout = path.join(tmpDir, 'rollout-x.jsonl');
    fs.writeFileSync(rollout, 'x'); // real file → real mtime for the change gate
    const resolveHistoryFile = vi.fn((_cwd: string, _sid: string) => rollout);
    const runtime = {
      id: 'codex',
      resolveHistoryDir: () => tmpDir,
      resolveHistoryFile,
      parseHistoryFile: () => [],
    } as unknown as RuntimeStrategy;
    const svc = new HistoryService(runtime, 'plugin-1', '/workspaces/proj');
    const loadSpy = vi.spyOn(svc, 'loadConversation').mockResolvedValue();

    const changed = await svc.uploadConversationIfChanged('codex-sess');

    expect(changed).toBe(true);
    // Resolved through the STRATEGY (cwd + session id) — NOT
    // path.join(projectDir, `${sid}.jsonl`).
    expect(resolveHistoryFile).toHaveBeenCalledWith('/workspaces/proj', 'codex-sess');
    expect(loadSpy).toHaveBeenCalledWith('codex-sess');
  });

  it('Codex: returns false (no upload) when the strategy finds no rollout for the id', async () => {
    const runtime = {
      id: 'codex',
      resolveHistoryDir: () => tmpDir,
      resolveHistoryFile: () => null,
      parseHistoryFile: () => [],
    } as unknown as RuntimeStrategy;
    const svc = new HistoryService(runtime, 'plugin-1', '/workspaces/proj');

    expect(await svc.uploadConversationIfChanged('missing')).toBe(false);
  });

  it('Codex: maps rollout NormalizedMessages to the wire shape — drops `system`, ISO→epoch ms', () => {
    const rollout = path.join(tmpDir, 'rollout-x.jsonl');
    fs.writeFileSync(rollout, 'x');
    const runtime = {
      id: 'codex',
      resolveHistoryDir: () => tmpDir,
      resolveHistoryFile: () => rollout,
      parseHistoryFile: () => [
        { id: 'rollout:0', role: 'user', text: 'hi', timestamp: '2025-05-07T17:24:22.000Z' },
        {
          id: 'rollout:1',
          role: 'system',
          text: 'injected ctx',
          timestamp: '2025-05-07T17:24:23.000Z',
        },
        {
          id: 'rollout:2',
          role: 'agent',
          text: 'hello back',
          timestamp: '2025-05-07T17:24:24.000Z',
        },
      ],
    } as unknown as RuntimeStrategy;
    const svc = new HistoryService(runtime, 'plugin-1', '/workspaces/proj');

    const read = (svc as unknown as WithRead).readConversation('codex-sess');

    expect(read).toEqual([
      {
        id: 'rollout:0',
        agentId: 'codex',
        role: 'user',
        text: 'hi',
        timestamp: new Date('2025-05-07T17:24:22.000Z').getTime(),
      },
      {
        id: 'rollout:2',
        agentId: 'codex',
        role: 'agent',
        text: 'hello back',
        timestamp: new Date('2025-05-07T17:24:24.000Z').getTime(),
      },
    ]);
  });

  it('Claude: keeps the <projectDir>/<id>.jsonl layout when the strategy has no resolveHistoryFile', () => {
    const sid = 'claude-sess';
    fs.writeFileSync(
      path.join(tmpDir, `${sid}.jsonl`),
      JSON.stringify({ type: 'user', uuid: 'u1', timestamp: 123, message: { content: 'hey' } }) +
        '\n',
    );
    const runtime = {
      id: 'claude',
      resolveHistoryDir: () => tmpDir,
    } as unknown as RuntimeStrategy;
    const svc = new HistoryService(runtime, 'plugin-1', '/workspaces/proj');

    const read = (svc as unknown as WithRead).readConversation(sid);

    expect(read).toEqual([
      { id: 'u1', agentId: 'claude', role: 'user', text: 'hey', timestamp: 123 },
    ]);
  });
});
