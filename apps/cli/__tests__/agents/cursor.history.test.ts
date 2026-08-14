import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  encodeCursorCwd,
  resolveHistoryFile,
  parseHistoryFile,
} from '../../src/agents/cursor/history';

// A real cursor-agent transcript (3 records, from a 2026.06.24 install).
const TRANSCRIPT = [
  JSON.stringify({
    role: 'user',
    message: { content: [{ type: 'text', text: '<user_query>\nhola\n</user_query>' }] },
  }),
  JSON.stringify({
    role: 'assistant',
    message: { content: [{ type: 'text', text: '¡Hola! ¿En qué puedo ayudarte?' }] },
  }),
  JSON.stringify({ type: 'turn_ended', status: 'completed' }),
].join('\n');

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length) rmSync(cleanups.pop() as string, { recursive: true, force: true });
});

function makeTranscript(cwd: string, sessionId: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cursor-proj-'));
  cleanups.push(root);
  const dir = path.join(root, encodeCursorCwd(cwd), 'agent-transcripts', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), TRANSCRIPT);
  return root;
}

describe('cursor/history', () => {
  it('encodeCursorCwd strips the leading separator and hyphenates the rest', () => {
    expect(encodeCursorCwd('/Users/edgar/Documents/codeagent-mobile')).toBe(
      'Users-edgar-Documents-codeagent-mobile',
    );
  });

  it('resolveHistoryFile finds the transcript via the computed <encoded-cwd> path', () => {
    const cwd = '/Users/edgar/Documents/proj';
    const id = 'c3e1a4e9-c2e6-48b4-9ee3-e74f2d2f98ff';
    const root = makeTranscript(cwd, id);
    const file = resolveHistoryFile(cwd, id, root);
    expect(file).toBe(
      path.join(root, encodeCursorCwd(cwd), 'agent-transcripts', id, `${id}.jsonl`),
    );
  });

  it('resolveHistoryFile falls back to scanning by unique sessionId when the cwd encoding differs', () => {
    const id = 'c3e1a4e9-c2e6-48b4-9ee3-e74f2d2f98ff';
    // Transcript stored under one cwd, but we resolve with a DIFFERENT cwd —
    // the sessionId scan still locates it (UUIDs are globally unique).
    const root = makeTranscript('/Users/edgar/Documents/proj', id);
    const file = resolveHistoryFile('/some/other/path', id, root);
    expect(file).not.toBeNull();
    expect(file).toContain(path.join('agent-transcripts', id, `${id}.jsonl`));
  });

  it('resolveHistoryFile returns null when nothing matches', () => {
    const root = makeTranscript('/Users/edgar/Documents/proj', 'session-a');
    expect(resolveHistoryFile('/Users/edgar/Documents/proj', 'session-b', root)).toBeNull();
  });

  it('parseHistoryFile normalizes user/assistant turns, unwraps <user_query>, skips turn_ended', () => {
    const id = 'sess-1';
    const root = makeTranscript('/Users/edgar/Documents/proj', id);
    const file = resolveHistoryFile('/Users/edgar/Documents/proj', id, root) as string;
    const msgs = parseHistoryFile(file);
    expect(msgs).toEqual([
      expect.objectContaining({ role: 'user', text: 'hola' }),
      expect.objectContaining({ role: 'agent', text: '¡Hola! ¿En qué puedo ayudarte?' }),
    ]);
    // turn_ended produced no message.
    expect(msgs).toHaveLength(2);
  });

  it('parseHistoryFile returns [] for a missing file (no throw)', () => {
    expect(parseHistoryFile('/no/such/transcript.jsonl')).toEqual([]);
  });

  // Same resource-content leak class as the fleet-1 2026-08-13 codex incident
  // (see `codex.history.test.ts`): `extractText` here only keeps blocks whose
  // `type === 'text'`, so a `resource`-shaped block structurally can never
  // surface as message text. Asserted, not assumed.
  it('never surfaces a non-text (resource-shaped) content block as message text', () => {
    const cwd = '/Users/edgar/Documents/proj';
    const id = 'sess-resource';
    const root = mkdtempSync(path.join(tmpdir(), 'cursor-proj-'));
    cleanups.push(root);
    const dir = path.join(root, encodeCursorCwd(cwd), 'agent-transcripts', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${id}.jsonl`),
      JSON.stringify({
        role: 'user',
        message: {
          content: [
            {
              type: 'resource',
              resource: { uri: 'codeam://squad-context', text: 'leaked context' },
            },
          ],
        },
      }),
    );
    const file = resolveHistoryFile(cwd, id, root) as string;
    expect(parseHistoryFile(file)).toEqual([]);
  });
});
