import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveHistoryDir,
  parseHistoryFile,
  getCurrentUsage,
} from '../../src/agents/codex/history';

describe('codex/history (rollouts)', () => {
  describe('resolveHistoryDir', () => {
    it('returns null when ~/.codex/sessions does not exist', () => {
      const fakeHome = path.join(tmpdir(), 'codex-h-nonexistent-' + Date.now());
      expect(resolveHistoryDir('/any/cwd', fakeHome)).toBeNull();
    });

    it("returns today's date bucket path when it exists", () => {
      const home = mkdtempSync(path.join(tmpdir(), 'codex-h-'));
      const now = new Date();
      const yyyy = String(now.getUTCFullYear());
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(now.getUTCDate()).padStart(2, '0');
      const dayDir = path.join(home, '.codex', 'sessions', yyyy, mm, dd);
      mkdirSync(dayDir, { recursive: true });
      expect(resolveHistoryDir('/any/cwd', home)).toBe(dayDir);
      rmSync(home, { recursive: true, force: true });
    });
  });

  describe('parseHistoryFile', () => {
    let origCwd: string;
    const dirsToClean: string[] = [];

    beforeEach(() => {
      origCwd = process.cwd();
    });
    afterEach(() => {
      // Restore cwd BEFORE rmSync — on Windows, `fs.rmSync(dir, …)`
      // throws EBUSY when `dir` is still the process cwd because the
      // OS keeps a handle on the current working directory. macOS /
      // Linux are lenient about this so the bug only surfaces in CI.
      process.chdir(origCwd);
      while (dirsToClean.length > 0) {
        const d = dirsToClean.pop()!;
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    });

    it('emits user + assistant messages from response_item records', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'codex-rollout-'));
      dirsToClean.push(dir);
      process.chdir(dir);

      const filePath = path.join(dir, 'rollout-2025-05-07T17-24-21-abc.jsonl');
      const lines = [
        JSON.stringify({
          timestamp: '2025-05-07T17:24:21.000Z',
          type: 'session_meta',
          payload: { id: 'sess1', cwd: dir, timestamp: '2025-05-07T17:24:21.000Z' },
        }),
        JSON.stringify({
          timestamp: '2025-05-07T17:24:22.000Z',
          type: 'response_item',
          payload: { Message: { role: 'user', content: [{ type: 'input_text', text: 'hi' }] } },
        }),
        JSON.stringify({
          timestamp: '2025-05-07T17:24:23.000Z',
          type: 'response_item',
          payload: {
            Message: {
              role: 'assistant',
              content: [{ type: 'output_text', text: 'hello back' }],
            },
          },
        }),
      ];
      writeFileSync(filePath, lines.join('\n'));

      const out = parseHistoryFile(filePath);
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({ id: 'rollout:0', role: 'user', text: 'hi' });
      expect(out[1]).toMatchObject({ id: 'rollout:1', role: 'agent', text: 'hello back' });
      expect(out[0].timestamp).toBe('2025-05-07T17:24:22.000Z');
    });

    it("returns [] when session_meta.cwd does not match process.cwd()", () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'codex-rollout-'));
      const wrongCwd = mkdtempSync(path.join(tmpdir(), 'codex-other-'));
      dirsToClean.push(dir, wrongCwd);
      process.chdir(dir);

      const filePath = path.join(dir, 'rollout.jsonl');
      writeFileSync(
        filePath,
        [
          JSON.stringify({
            timestamp: '2025-05-07T17:24:21.000Z',
            type: 'session_meta',
            payload: { cwd: wrongCwd },
          }),
          JSON.stringify({
            timestamp: '2025-05-07T17:24:22.000Z',
            type: 'response_item',
            payload: {
              Message: { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
            },
          }),
        ].join('\n'),
      );

      expect(parseHistoryFile(filePath)).toEqual([]);
    });

    it('skips non-Message response_item variants (tool calls, reasoning)', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'codex-rollout-'));
      dirsToClean.push(dir);
      process.chdir(dir);

      const filePath = path.join(dir, 'rollout.jsonl');
      writeFileSync(
        filePath,
        [
          JSON.stringify({
            timestamp: '2025-05-07T17:24:21.000Z',
            type: 'session_meta',
            payload: { cwd: dir },
          }),
          JSON.stringify({
            timestamp: '2025-05-07T17:24:22.000Z',
            type: 'response_item',
            payload: { FunctionCall: { name: 'shell', args: '...' } },
          }),
          JSON.stringify({
            timestamp: '2025-05-07T17:24:23.000Z',
            type: 'response_item',
            payload: { Reasoning: { content: 'thinking...' } },
          }),
          JSON.stringify({
            timestamp: '2025-05-07T17:24:24.000Z',
            type: 'response_item',
            payload: {
              Message: {
                role: 'assistant',
                content: [{ type: 'output_text', text: 'done' }],
              },
            },
          }),
        ].join('\n'),
      );

      const out = parseHistoryFile(filePath);
      expect(out).toHaveLength(1);
      expect(out[0].text).toBe('done');
    });

    it('skips malformed JSON lines', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'codex-rollout-'));
      dirsToClean.push(dir);
      process.chdir(dir);

      const filePath = path.join(dir, 'rollout.jsonl');
      writeFileSync(
        filePath,
        [
          JSON.stringify({
            timestamp: '2025-05-07T17:24:21.000Z',
            type: 'session_meta',
            payload: { cwd: dir },
          }),
          'not json at all',
          JSON.stringify({
            timestamp: '2025-05-07T17:24:22.000Z',
            type: 'response_item',
            payload: {
              Message: { role: 'user', content: [{ type: 'input_text', text: 'keep me' }] },
            },
          }),
        ].join('\n'),
      );

      const out = parseHistoryFile(filePath);
      expect(out).toHaveLength(1);
      expect(out[0].text).toBe('keep me');
    });
  });

  describe('getCurrentUsage', () => {
    it('returns null when no rollout files in dir', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'codex-no-rollouts-'));
      expect(getCurrentUsage(dir)).toBeNull();
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns last TokenCount info from newest rollout', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'codex-rollout-'));
      const filePath = path.join(dir, 'rollout-1.jsonl');
      writeFileSync(
        filePath,
        [
          JSON.stringify({
            timestamp: '2025-05-07T17:24:21.000Z',
            type: 'event_msg',
            payload: {
              TokenCount: {
                info: { total_token_usage: { total_tokens: 10_000 }, model_context_window: 272_000 },
              },
            },
          }),
          JSON.stringify({
            timestamp: '2025-05-07T17:24:22.000Z',
            type: 'event_msg',
            payload: {
              TokenCount: {
                info: { total_token_usage: { total_tokens: 50_000 }, model_context_window: 272_000 },
              },
            },
          }),
        ].join('\n'),
      );

      const usage = getCurrentUsage(dir);
      expect(usage).toEqual({ used: 50_000, total: 272_000, percent: 18 });
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
