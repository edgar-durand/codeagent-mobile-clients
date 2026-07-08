import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveHistoryDir,
  resolveHistoryFile,
  parseHistoryFile,
} from '../../src/agents/gemini/history';

// A real Gemini 0.45 chat transcript (shape captured from a live install):
// header line, a `$set` bootstrap carrying the synthetic <session_context>
// user turn, then standalone user/gemini records (user content is a STRINGIFIED
// `[{text}]`, gemini content is a plain string).
function transcript(sessionId: string): string {
  return [
    JSON.stringify({
      sessionId,
      projectHash: 'hash',
      startTime: '2026-06-06T02:37:09.500Z',
      lastUpdated: '2026-06-06T02:37:09.500Z',
      kind: 'main',
    }),
    JSON.stringify({
      $set: {
        messages: [
          {
            id: 'm0',
            timestamp: '2026-06-06T02:37:53.754Z',
            type: 'user',
            content: [{ text: '<session_context>\nThis is the Gemini CLI…' }],
          },
        ],
      },
    }),
    JSON.stringify({ $set: { lastUpdated: '2026-06-06T02:38:00.000Z' } }),
    JSON.stringify({
      id: 'm1',
      timestamp: '2026-06-06T02:38:01.000Z',
      type: 'user',
      content: '[{"text":"give me a hello world"}]',
    }),
    JSON.stringify({
      id: 'm2',
      timestamp: '2026-06-06T02:38:02.000Z',
      type: 'gemini',
      content: '```typescript\nconsole.log("Hello, world!");\n```',
    }),
  ].join('\n');
}

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length) rmSync(cleanups.pop() as string, { recursive: true, force: true });
});

// Build a fake ~/.gemini root with projects.json + a chats transcript.
function makeGeminiRoot(cwd: string, projectName: string, sessionId: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'gemini-'));
  cleanups.push(root);
  writeFileSync(path.join(root, 'projects.json'), JSON.stringify({ projects: { [cwd]: projectName } }));
  const chats = path.join(root, 'tmp', projectName, 'chats');
  mkdirSync(chats, { recursive: true });
  const file = path.join(chats, `session-2026-06-06T02-37-${sessionId.slice(0, 8)}.jsonl`);
  writeFileSync(file, transcript(sessionId));
  return root;
}

describe('gemini/history', () => {
  const CWD = '/Users/edgar/Documents/proj';
  const SID = '5659a682-699c-4c1e-8699-a8174666ec1c';

  it('resolveHistoryDir maps cwd → project name via projects.json', () => {
    const root = makeGeminiRoot(CWD, 'proj-alias', SID);
    expect(resolveHistoryDir(CWD, root)).toBe(path.join(root, 'tmp', 'proj-alias', 'chats'));
  });

  it('resolveHistoryFile locates the transcript by the session id embedded in the filename', () => {
    const root = makeGeminiRoot(CWD, 'proj-alias', SID);
    const file = resolveHistoryFile(CWD, SID, root);
    expect(file).toContain(`-${SID.slice(0, 8)}.jsonl`);
  });

  it('parseHistoryFile emits real user+gemini turns, filters <session_context>, dedups by id', () => {
    const root = makeGeminiRoot(CWD, 'proj-alias', SID);
    const file = resolveHistoryFile(CWD, SID, root) as string;
    const msgs = parseHistoryFile(file);
    expect(msgs.map((m) => [m.role, m.text])).toEqual([
      ['user', 'give me a hello world'],
      ['agent', '```typescript\nconsole.log("Hello, world!");\n```'],
    ]);
  });

  it('parseHistoryFile returns [] for a missing file (no throw)', () => {
    expect(parseHistoryFile('/no/such/session.jsonl')).toEqual([]);
  });
});
