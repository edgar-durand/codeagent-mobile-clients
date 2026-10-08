import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { prefetchIntoPageCache } from '../../../src/agents/acp/agent-binary';

// codeagent-w683: the agent binary is read once, sequentially, before the
// spawn so a cold codespace disk doesn't page it in by faults inside
// `session/new`.
describe('prefetchIntoPageCache', () => {
  it('reads the whole file through to the end', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w683-'));
    const file = path.join(dir, 'claude');
    fs.writeFileSync(file, Buffer.alloc(9 * 1024 * 1024, 1));
    const realCreate = fs.createReadStream;
    let stream: fs.ReadStream | undefined;
    prefetchIntoPageCache(file, {
      createReadStream: ((p: fs.PathLike, o?: Parameters<typeof fs.createReadStream>[1]) => {
        stream = realCreate(p, o);
        return stream;
      }) as typeof fs.createReadStream,
    });
    expect(stream).toBeDefined();
    // 'close', not 'end': the fd is released after 'end', and Windows refuses
    // to remove a directory that still holds an open file (ENOTEMPTY).
    await new Promise<void>((resolve) => stream!.on('close', () => resolve()));
    expect(stream!.bytesRead).toBe(9 * 1024 * 1024);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never throws — a missing file or a throwing opener is ignored', async () => {
    expect(() => prefetchIntoPageCache('/nonexistent/w683/claude')).not.toThrow();
    expect(() =>
      prefetchIntoPageCache('/x', {
        createReadStream: (() => {
          throw new Error('EMFILE');
        }) as unknown as typeof fs.createReadStream,
      }),
    ).not.toThrow();
    // A stream error after open must not become an unhandled 'error' event.
    const fake = new EventEmitter() as EventEmitter & { resume: () => void };
    fake.resume = vi.fn();
    prefetchIntoPageCache('/x', {
      createReadStream: (() => fake) as unknown as typeof fs.createReadStream,
    });
    expect(() => fake.emit('error', new Error('EIO'))).not.toThrow();
    expect(fake.resume).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 20));
  });
});
