import { describe, it, expect } from 'vitest';
import {
  batchConversation,
  CONVERSATION_BATCH_MAX_BYTES,
  CONVERSATION_BATCH_MAX_MESSAGES,
} from '../src/services/history.service';

/**
 * The transcript upload used to go out in 30-message batches: a 74 MB session
 * (owner, 2026-09-04) meant hundreds of POSTs into a 100 req/min throttle →
 * 429 on every one past the first hundred → the mobile never found the
 * conversation and kept "Connecting to your session" forever. Batches are now
 * bounded by BOTH count and serialized size.
 */
describe('batchConversation — few requests, none over the body limit', () => {
  const msg = (i: number, bytes: number) => ({
    id: `m${i}`,
    role: 'user',
    text: 'x'.repeat(bytes),
  });

  it('packs small messages 150 to a batch (a 3000-message transcript = 20 POSTs, not 100)', () => {
    const messages = Array.from({ length: 3000 }, (_, i) => msg(i, 200));
    const batches = batchConversation(messages);
    expect(batches).toHaveLength(Math.ceil(3000 / CONVERSATION_BATCH_MAX_MESSAGES));
    expect(batches.flat()).toHaveLength(3000); // nothing lost, order kept
    expect(batches.flat()[0]).toBe(messages[0]);
    expect(batches.flat()[2999]).toBe(messages[2999]);
  });

  it('closes a batch by SIZE before the count is reached', () => {
    // 1 MB messages: two per batch at most under the 2 MB cap.
    const messages = Array.from({ length: 5 }, (_, i) => msg(i, 1024 * 1024));
    const batches = batchConversation(messages);
    expect(batches.map((b) => b.length)).toEqual([1, 1, 1, 1, 1]);
    for (const b of batches) {
      expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThanOrEqual(
        CONVERSATION_BATCH_MAX_BYTES + 64,
      );
    }
  });

  it('never splits below one message — an oversized message ships alone', () => {
    const big = msg(0, 3 * 1024 * 1024);
    const batches = batchConversation([msg(1, 10), big, msg(2, 10)]);
    expect(batches.map((b) => b.length)).toEqual([1, 1, 1]);
    expect(batches[1][0]).toBe(big);
  });

  it('returns nothing for an empty conversation', () => {
    expect(batchConversation([])).toEqual([]);
  });
});
