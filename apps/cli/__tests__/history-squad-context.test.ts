/**
 * Hydration guard (P2-0, fleet-1 2026-08-14 P0): the JSONL → conversation
 * path must never replay injected Agent Squad context as a visible USER
 * bubble.
 *
 * Two shapes reach the transcript:
 *  - the NATIVE `codeam://squad-context` resource block (what the CLI sends
 *    today) — a non-text content block, so it must not contribute any text;
 *  - the LEGACY text blocks (pre-fix history already on disk, plus any adapter
 *    that fell back) — scrubbed by the marker strip.
 *
 * Drives the real `HistoryService` over a real temp JSONL, asserting on the
 * messages every hydration caller (`loadConversation` / `uploadDelta`) gets.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HistoryService } from '../src/services/history.service';
import type { RuntimeStrategy } from '../src/agents/strategy';
import type { NormalizedMessage } from '@codeam/shared';

let tmpDir: string;
const SID = 'conv-1';

function makeService(): HistoryService {
  const runtime = {
    id: 'claude',
    resolveHistoryDir: () => tmpDir,
  } as unknown as RuntimeStrategy;
  return new HistoryService(runtime, 'plugin-1', '/workspaces/proj');
}

interface HydratedMessage {
  id: string;
  role: string;
  text: string;
  timestamp: number;
}

/**
 * `readConversation` is the single choke point every hydration caller goes
 * through (`loadConversation` batches it, `uploadDelta` slices it), so the
 * scrub is asserted there — no network, no batching noise. Private only in
 * the TypeScript sense.
 */
function hydrate(svc: HistoryService): HydratedMessage[] {
  return (svc as unknown as { readConversation(sid: string): HydratedMessage[] }).readConversation(
    SID,
  );
}

function writeJsonl(records: unknown[]): void {
  fs.writeFileSync(
    path.join(tmpDir, `${SID}.jsonl`),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
}

const HANDOFF = [
  '[Session handoff] You (Codex CLI) are taking over a live coding session previously driven by Claude Code. ',
  'The conversation below is context from that session — continue the work seamlessly from where it left off. ',
  'Do not re-introduce yourself or re-do completed work.\n\n',
  '--- Recent conversation with Claude Code ---\n',
  'user: fix the parser\nagent: done\n',
  '--- End of handoff context ---',
].join('');

describe('conversation hydration — squad context never becomes a user bubble', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-hist-squad-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('drops the native codeam://squad-context resource block, keeping the user words', () => {
    writeJsonl([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-08-14T10:00:00.000Z',
        message: {
          content: [
            {
              type: 'resource',
              resource: {
                uri: 'codeam://squad-context',
                mimeType: 'text/plain',
                text: '[Team context] You are the active agent…',
              },
            },
            { type: 'text', text: 'now the tests' },
          ],
        },
      },
    ]);
    expect(hydrate(makeService())).toEqual([
      expect.objectContaining({ role: 'user', text: 'now the tests' }),
    ]);
  });

  it('scrubs LEGACY text-block markers out of pre-fix history', () => {
    writeJsonl([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-08-14T10:00:00.000Z',
        message: {
          content: [
            { type: 'text', text: HANDOFF },
            { type: 'text', text: 'go' },
          ],
        },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-08-14T10:00:05.000Z',
        message: { content: [{ type: 'text', text: 'On it.' }] },
      },
    ]);
    const messages = hydrate(makeService());
    expect(messages.map((m) => m.text)).toEqual(['go', 'On it.']);
    expect(JSON.stringify(messages)).not.toContain('[Session handoff]');
  });

  it('drops a message that was ENTIRELY injected context', () => {
    writeJsonl([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-08-14T10:00:00.000Z',
        message: { content: [{ type: 'text', text: HANDOFF }] },
      },
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-08-14T10:00:01.000Z',
        message: { content: [{ type: 'text', text: 'real question' }] },
      },
    ]);
    expect(hydrate(makeService()).map((m) => m.text)).toEqual(['real question']);
  });

  it('leaves ordinary conversations byte-identical', () => {
    writeJsonl([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-08-14T10:00:00.000Z',
        message: { content: [{ type: 'text', text: 'hello\n- a bullet\n[not a marker]' }] },
      },
    ]);
    expect(hydrate(makeService())[0].text).toBe('hello\n- a bullet\n[not a marker]');
  });
});

/**
 * fleet-1 2026-08-13 (codeam-cli 2.65.0): the SAME chokepoint (`readConversation`
 * → `scrubSquadContext`) also has to cover agents whose `RuntimeStrategy` goes
 * through `resolveHistoryFile`/`parseHistoryFile` (codex, gemini, cursor) rather
 * than the claude JSONL path above. Drives a fake strategy so the check is
 * agent-shaped without needing a real codex rollout on disk.
 */
describe('conversation hydration — resolveHistoryFile agents (codex/gemini/cursor shape)', () => {
  function makeServiceWithParsedMessages(messages: NormalizedMessage[]): HistoryService {
    const runtime = {
      id: 'codex',
      resolveHistoryDir: () => null,
      resolveHistoryFile: () => '/fake/rollout.jsonl',
      parseHistoryFile: () => messages,
    } as unknown as RuntimeStrategy;
    return new HistoryService(runtime, 'plugin-1', '/workspaces/proj');
  }

  it('drops a codeam://squad-context resource block downgraded to plain text by a third-party ACP bridge', () => {
    const svc = makeServiceWithParsedMessages([
      {
        id: 'rollout:0',
        role: 'user',
        text: 'codeam://squad-context <context resource text="[Team context] …">',
        timestamp: '2026-08-13T09:00:00.000Z',
      },
      {
        id: 'rollout:1',
        role: 'user',
        text: 'start the server',
        timestamp: '2026-08-13T09:00:01.000Z',
      },
    ]);
    expect(hydrate(svc).map((m) => m.text)).toEqual(['start the server']);
  });

  it("drops an agent-injected <recommended_plugins> meta block, never surfacing it as the user's words", () => {
    const svc = makeServiceWithParsedMessages([
      {
        id: 'rollout:0',
        role: 'user',
        text: '<recommended_plugins>\n  - openai/curated-remote-plugin-a\n</recommended_plugins>',
        timestamp: '2026-08-13T09:00:00.000Z',
      },
      {
        id: 'rollout:1',
        role: 'user',
        text: 'deploy the codespace agent',
        timestamp: '2026-08-13T09:00:01.000Z',
      },
    ]);
    expect(hydrate(svc).map((m) => m.text)).toEqual(['deploy the codespace agent']);
  });

  it('leaves an ordinary codex/gemini/cursor conversation byte-identical', () => {
    const svc = makeServiceWithParsedMessages([
      { id: 'rollout:0', role: 'user', text: 'fix the bug', timestamp: '2026-08-13T09:00:00.000Z' },
      { id: 'rollout:1', role: 'agent', text: 'done', timestamp: '2026-08-13T09:00:01.000Z' },
    ]);
    expect(hydrate(svc).map((m) => m.text)).toEqual(['fix the bug', 'done']);
  });
});
