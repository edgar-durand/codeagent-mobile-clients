import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveHistoryDir,
  parseHistoryFile,
  getCurrentUsage,
} from '../../src/agents/codex/history';

describe('codex/history', () => {
  it('resolveHistoryDir returns null when ~/.codex does not exist', () => {
    const fakeHome = path.join(tmpdir(), 'codex-h-nonexistent-' + Date.now());
    expect(resolveHistoryDir('/any/cwd', fakeHome)).toBeNull();
  });

  it('resolveHistoryDir returns the ~/.codex dir when history.jsonl exists', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'codex-h-'));
    const codexDir = path.join(home, '.codex');
    mkdirSync(codexDir);
    writeFileSync(path.join(codexDir, 'history.jsonl'), '');
    expect(resolveHistoryDir('/any/cwd', home)).toBe(codexDir);
    rmSync(home, { recursive: true, force: true });
  });

  it('parseHistoryFile maps Codex JSONL records to NormalizedMessage[]', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codex-h-'));
    const filePath = path.join(dir, 'history.jsonl');
    const lines = [
      JSON.stringify({ session_id: 's1', ts: 1700000000, text: 'hi' }),
      JSON.stringify({ session_id: 's1', ts: 1700000010, text: 'hello back' }),
    ];
    writeFileSync(filePath, lines.join('\n'));

    const out = parseHistoryFile(filePath);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: expect.stringContaining('s1'),
      role: 'user',
      text: 'hi',
    });
    expect(out[0].timestamp).toBe('2023-11-14T22:13:20.000Z');
    rmSync(dir, { recursive: true, force: true });
  });

  it('parseHistoryFile skips malformed lines', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codex-h-'));
    const filePath = path.join(dir, 'history.jsonl');
    writeFileSync(filePath, [
      JSON.stringify({ session_id: 's', ts: 1700000000, text: 'good' }),
      'not json at all',
      '{"missing":"required fields"}',
      JSON.stringify({ session_id: 's', ts: 1700000010, text: 'still here' }),
    ].join('\n'));

    const out = parseHistoryFile(filePath);
    expect(out).toHaveLength(2);
    expect(out.map(m => m.text)).toEqual(['good', 'still here']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('getCurrentUsage returns null (Codex history has no token data)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codex-h-'));
    writeFileSync(path.join(dir, 'history.jsonl'), JSON.stringify({
      session_id: 's', ts: 1700000000, text: 'x',
    }));
    expect(getCurrentUsage(dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
