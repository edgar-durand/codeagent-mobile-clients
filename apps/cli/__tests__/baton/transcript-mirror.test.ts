import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TranscriptMirror } from '../../src/baton/transcript-mirror';
import type { NormalizedMessage } from '@codeam/shared';

function makeRuntime(file: string) {
  // Minimal parse: one NormalizedMessage per JSONL line.
  return {
    resolveHistoryFile: (_cwd: string, _id: string) => file,
    parseHistoryFile: (f: string): NormalizedMessage[] =>
      fs
        .readFileSync(f, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .map(
          (o, i): NormalizedMessage => ({
            id: String(i),
            role: o.message.role === 'assistant' ? 'agent' : 'user',
            text: String(o.message.content),
            timestamp: new Date(0).toISOString(),
          }),
        ),
  };
}

describe('TranscriptMirror', () => {
  it('emits only NEW messages when the file grows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'));
    const file = path.join(dir, 'conv.jsonl');
    fs.copyFileSync(path.join(__dirname, '../fixtures/baton/conv.jsonl'), file);
    let fireChange: () => void = () => {};
    const onNewMessages = vi.fn();
    const mirror = new TranscriptMirror({
      runtime: makeRuntime(file),
      cwd: dir,
      conversationId: 'conv-1',
      onNewMessages,
      watch: (_f, cb) => {
        fireChange = cb;
        return () => {};
      },
    });
    mirror.start();
    expect(onNewMessages).toHaveBeenCalledTimes(1);
    expect(onNewMessages.mock.calls[0][0]).toHaveLength(2); // initial snapshot

    fs.appendFileSync(file, '{"type":"user","message":{"role":"user","content":"more"}}\n');
    fireChange();
    expect(onNewMessages).toHaveBeenCalledTimes(2);
    const delta = onNewMessages.mock.calls[1][0] as NormalizedMessage[];
    expect(delta).toHaveLength(1);
    expect(delta[0].text).toBe('more'); // only the new message, not a re-emit
    mirror.stop();
  });
});
