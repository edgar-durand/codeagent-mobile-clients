import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withTimeout } from '../../src/agents/acp/withTimeout';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    const p = Promise.resolve('done');
    await expect(withTimeout(p, 1000)).resolves.toBe('done');
  });

  it('resolves undefined when the deadline elapses first', async () => {
    const never = new Promise<string>(() => {});
    const race = withTimeout(never, 500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(race).resolves.toBeUndefined();
  });

  it('never rejects even if the inner promise rejects', async () => {
    const boom = Promise.reject(new Error('boom'));
    await expect(withTimeout(boom, 1000)).resolves.toBeUndefined();
  });
});
