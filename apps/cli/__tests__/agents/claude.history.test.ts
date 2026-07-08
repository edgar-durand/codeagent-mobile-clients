import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveHistoryDir,
  resolveHistoryFile,
  parseHistoryFile,
  encodeCwd,
} from '../../src/agents/claude/history';

describe('claude/history', () => {
  it('encodeCwd replaces separators with hyphens', () => {
    expect(encodeCwd('/Users/alice/work')).toBe('-Users-alice-work');
  });

  it('encodeCwd collapses underscores to hyphens (matches real Claude Code)', () => {
    expect(encodeCwd('/Users/alice/my_project')).toBe('-Users-alice-my-project');
  });

  it('resolveHistoryDir returns null when the dir does not exist', () => {
    const fakeRoot = path.join(tmpdir(), 'claude-h-nonexistent-' + Date.now());
    expect(resolveHistoryDir('/non/existent/cwd', fakeRoot)).toBeNull();
  });

  describe('resolveHistoryFile', () => {
    it('returns the <historyDir>/<sessionId>.jsonl path when the file exists', () => {
      const projectsRoot = mkdtempSync(path.join(tmpdir(), 'claude-h-root-'));
      const cwd = '/Users/alice/work';
      const historyDir = path.join(projectsRoot, encodeCwd(cwd));
      mkdirSync(historyDir, { recursive: true });
      const sessionId = 'c046ec1f-ab2e-4eb3-beff-4b9159174a1d';
      const filePath = path.join(historyDir, `${sessionId}.jsonl`);
      writeFileSync(filePath, '');

      expect(resolveHistoryFile(cwd, sessionId, projectsRoot)).toBe(filePath);
      rmSync(projectsRoot, { recursive: true, force: true });
    });

    it('returns null when the history dir resolves but the file is missing', () => {
      const projectsRoot = mkdtempSync(path.join(tmpdir(), 'claude-h-root-'));
      const cwd = '/Users/alice/work';
      const historyDir = path.join(projectsRoot, encodeCwd(cwd));
      mkdirSync(historyDir, { recursive: true });

      expect(resolveHistoryFile(cwd, 'no-such-session', projectsRoot)).toBeNull();
      rmSync(projectsRoot, { recursive: true, force: true });
    });

    it('returns null when the history dir itself does not exist', () => {
      const projectsRoot = path.join(tmpdir(), 'claude-h-root-nonexistent-' + Date.now());
      expect(resolveHistoryFile('/non/existent/cwd', 'sess', projectsRoot)).toBeNull();
    });
  });

  it('parseHistoryFile maps Claude JSONL to NormalizedMessage', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-h-'));
    const filePath = path.join(dir, 's.jsonl');
    const lines = [
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-05-13T00:00:00Z',
        message: { content: 'hi' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-05-13T00:00:01Z',
        message: {
          content: [{ type: 'text', text: 'hello' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ];
    writeFileSync(filePath, lines.join('\n'));
    const out = parseHistoryFile(filePath);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 'u1', role: 'user', text: 'hi' });
    expect(out[1]).toMatchObject({ id: 'a1', role: 'agent', text: 'hello' });
    expect(out[1].usage).toMatchObject({ input: 10, output: 5 });
    rmSync(dir, { recursive: true, force: true });
  });

  it('parseHistoryFile maps cache_read + cache_creation tokens', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-h-'));
    const filePath = path.join(dir, 's.jsonl');
    writeFileSync(filePath, JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-05-13T00:00:00Z',
      message: {
        content: [{ type: 'text', text: 'x' }],
        usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
      },
    }));
    const out = parseHistoryFile(filePath);
    expect(out[0].usage).toMatchObject({
      input: 5,
      output: 3,
      cacheRead: 100,
      cacheCreation: 50,
    });
    rmSync(dir, { recursive: true, force: true });
  });
});
