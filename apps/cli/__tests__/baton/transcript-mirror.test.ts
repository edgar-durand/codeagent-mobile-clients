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
    // ⚠️ The file was ALREADY on disk when start() ran, so this first batch is
    // history the mirror is catching up on — not turns that just happened. The
    // consumer replays only live batches over the output pipe; getting this
    // wrong replayed whole conversations onto the phone message by message
    // (owner report 2026-09-03).
    expect(onNewMessages.mock.calls[0][1]).toEqual({ preexisting: true });

    fs.appendFileSync(file, '{"type":"user","message":{"role":"user","content":"more"}}\n');
    fireChange();
    expect(onNewMessages).toHaveBeenCalledTimes(2);
    const delta = onNewMessages.mock.calls[1][0] as NormalizedMessage[];
    expect(delta).toHaveLength(1);
    expect(delta[0].text).toBe('more'); // only the new message, not a re-emit
    mirror.stop();
  });

  it('WAITS for the transcript file to appear, then attaches and tails it', () => {
    // The native TUI creates its <sessionId>.jsonl only on the first turn, so
    // at LOCAL_DRIVE begin the file does not exist yet. The mirror must poll
    // and attach the moment it appears — not bail out permanently.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-wait-'));
    const file = path.join(dir, 'conv.jsonl'); // not created yet

    // Manual fake interval so the poll is fully deterministic.
    let tick: () => void = () => {};
    let cleared = false;
    const setIntervalFn = (fn: () => void, _ms: number) => {
      tick = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    };
    const clearIntervalFn = () => {
      cleared = true;
    };

    let fireChange: () => void = () => {};
    const onNewMessages = vi.fn();
    // resolveHistoryFile mimics claude's: null until the file exists on disk.
    const runtime = {
      resolveHistoryFile: (_cwd: string, _id: string) => (fs.existsSync(file) ? file : null),
      parseHistoryFile: makeRuntime(file).parseHistoryFile,
    };
    const mirror = new TranscriptMirror({
      runtime,
      cwd: dir,
      conversationId: 'conv-1',
      onNewMessages,
      watch: (_f, cb) => {
        fireChange = cb;
        return () => {};
      },
      pollIntervalMs: 100,
      waitTimeoutMs: 10_000,
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
    });

    mirror.start();
    // File absent → nothing emitted, poll is armed.
    expect(onNewMessages).not.toHaveBeenCalled();

    // A poll tick while the file is still absent does not attach.
    tick();
    expect(onNewMessages).not.toHaveBeenCalled();

    // The native TUI writes its first turn; the next poll tick attaches.
    fs.copyFileSync(path.join(__dirname, '../fixtures/baton/conv.jsonl'), file);
    tick();
    // Attached from the POLL: the agent created the transcript after we began
    // watching, so its contents are live turns and must be flagged as such —
    // this is the brand-new-session case that has to stream from turn one.
    expect(onNewMessages.mock.calls[0][1]).toEqual({ preexisting: false });
    expect(onNewMessages).toHaveBeenCalledTimes(1);
    expect(onNewMessages.mock.calls[0][0]).toHaveLength(2); // initial snapshot
    expect(cleared).toBe(true); // poll stopped once attached

    // Now watching — subsequent growth tails as deltas.
    fs.appendFileSync(file, '{"type":"user","message":{"role":"user","content":"more"}}\n');
    fireChange();
    expect(onNewMessages).toHaveBeenCalledTimes(2);
    expect((onNewMessages.mock.calls[1][0] as NormalizedMessage[])[0].text).toBe('more');
    mirror.stop();
  });

  it('stop() clears the startup poll when the file never appears', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-stop-'));
    const file = path.join(dir, 'never.jsonl');
    let cleared = false;
    const mirror = new TranscriptMirror({
      runtime: {
        resolveHistoryFile: () => (fs.existsSync(file) ? file : null),
        parseHistoryFile: () => [],
      },
      cwd: dir,
      conversationId: 'conv-1',
      onNewMessages: vi.fn(),
      watch: () => () => {},
      setInterval: (_fn, _ms) => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {
        cleared = true;
      },
    });
    mirror.start();
    mirror.stop();
    expect(cleared).toBe(true);
  });
});
