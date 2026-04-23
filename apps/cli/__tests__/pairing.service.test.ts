import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use the real module but mock internal http calls with vi.spyOn after import
import * as pairing from '../src/services/pairing.service';

describe('requestCode', () => {
  it('returns code and expiresAt on success', async () => {
    vi.spyOn(pairing._transport, 'postJson').mockResolvedValue({
      data: { code: 'ABC123', expiresAt: 9999999999000 },
    } as never);

    const result = await pairing.requestCode('plugin-1');
    expect(result).toEqual({ code: 'ABC123', expiresAt: 9999999999000 });
  });

  it('returns null when server fails', async () => {
    vi.spyOn(pairing._transport, 'postJson').mockResolvedValue(null);
    const result = await pairing.requestCode('plugin-1');
    expect(result).toBeNull();
  });
});

describe('pollStatus', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it('calls onPaired when server returns paired:true', async () => {
    vi.spyOn(pairing._transport, 'getJson').mockResolvedValue({
      data: {
        paired: true,
        sessionId: 'sess_1',
        user: { name: 'Edgar', email: 'e@e.com', plan: 'PRO' },
      },
    } as never);

    const onPaired = vi.fn();
    const onTimeout = vi.fn();
    pairing.pollStatus('plugin-1', onPaired, onTimeout);

    await vi.advanceTimersByTimeAsync(3100);
    expect(onPaired).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      userName: 'Edgar',
      userEmail: 'e@e.com',
      plan: 'PRO',
    });
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('calls onTimeout after 5 minutes without pairing', async () => {
    vi.spyOn(pairing._transport, 'getJson').mockResolvedValue({
      data: { paired: false },
    } as never);

    const onPaired = vi.fn();
    const onTimeout = vi.fn();
    pairing.pollStatus('plugin-1', onPaired, onTimeout);

    await vi.advanceTimersByTimeAsync(301_000);
    expect(onTimeout).toHaveBeenCalled();
    expect(onPaired).not.toHaveBeenCalled();
  });
});
