import { afterEach, describe, expect, it, vi } from 'vitest';

import { _testHelpers } from '../src/services/telemetry.service';

const { resilientFetch } = _testHelpers;

describe('telemetry resilientFetch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes a successful response straight through', async () => {
    const ok = new Response('{}', { status: 200 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok);

    const res = await resilientFetch('https://us.i.posthog.com/batch/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"batch":[]}',
    });

    expect(res).toBe(ok);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('swallows a network/DNS failure and resolves to a synthetic 200', async () => {
    // The exact failure from the bug report: getaddrinfo ENOTFOUND.
    const netErr = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND us.i.posthog.com'), {
        code: 'ENOTFOUND',
      }),
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(netErr);

    // Must NOT throw — that's what crashed the CLI / spammed the session PTY.
    const res = await resilientFetch('https://us.i.posthog.com/batch/', {
      method: 'POST',
      headers: {},
      body: '{"batch":[]}',
    });

    // Synthetic OK → PostHog treats the batch as delivered and drains the
    // queue instead of retrying it forever.
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('');
    await expect(res.json()).resolves.toEqual({});
    expect(res.body).toBeNull();
  });
});
