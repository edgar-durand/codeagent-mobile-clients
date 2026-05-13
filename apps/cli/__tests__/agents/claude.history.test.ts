import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveHistoryDir,
  parseHistoryFile,
  encodeCwd,
} from '../../src/agents/claude/history';

describe('claude/history', () => {
  it('encodeCwd replaces separators with hyphens', () => {
    expect(encodeCwd('/Users/alice/work')).toBe('-Users-alice-work');
  });

  it('resolveHistoryDir returns null when the dir does not exist', () => {
    const fakeRoot = path.join(tmpdir(), 'claude-h-nonexistent-' + Date.now());
    expect(resolveHistoryDir('/non/existent/cwd', fakeRoot)).toBeNull();
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
