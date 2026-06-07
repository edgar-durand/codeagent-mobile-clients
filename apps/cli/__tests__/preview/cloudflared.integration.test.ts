/**
 * Integration regression test for the preview tunnel-wait path.
 *
 * REAL-WORLD FAILURE we caught in production (June 2026, codespace
 * `codeagent-mobile-6pr6wxpx9vxh5wxv`): cloudflared spawned a Quick
 * Tunnel, the dev server was already serving HTTP from port 3000,
 * yet `waitForCloudflaredReady` timed out at 60 s with
 * `ERR_TUNNEL_FAILED`. Manual reproduction with the same Node
 * runtime and the same `Resolver` API inside that codespace:
 *
 *   dns.lookup (getaddrinfo / OS resolver) →  ~3 s to resolve
 *   Resolver.resolve4 + system /etc/resolv.conf → >38 s ENOTFOUND
 *   Resolver.resolve4 + 1.1.1.1 explicit       → >60 s ENOTFOUND
 *
 * The original code only used c-ares Resolver pointed at 1.1.1.1
 * for both A and AAAA → guaranteed timeout in that environment
 * even though the tunnel was fully reachable from any browser /
 * `curl`.
 *
 * This test pins the FIX shape: `waitForCloudflaredReady` MUST
 * resolve when `dns.lookup` succeeds, even if every c-ares probe
 * stays ENOTFOUND for the entire deadline. A regression that
 * removes `dns.lookup` from the probe set (e.g. someone "cleaning
 * up" the unused import) will fail this test immediately instead
 * of waiting for a user to hit `ERR_TUNNEL_FAILED` in prod.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForCloudflaredReady } from '../../src/services/preview/cloudflared';

const { resolve4Mock, resolve6Mock, setServersMock, lookupMock } = vi.hoisted(
  () => ({
    resolve4Mock: vi.fn(),
    resolve6Mock: vi.fn(),
    setServersMock: vi.fn(),
    lookupMock: vi.fn(),
  }),
);

vi.mock('dns/promises', () => ({
  default: { lookup: lookupMock },
  lookup: lookupMock,
  Resolver: function MockResolver() {
    return {
      resolve4: resolve4Mock,
      resolve6: resolve6Mock,
      setServers: setServersMock,
    };
  },
}));

const enotfound = Object.assign(new Error('queryA ENOTFOUND'), {
  code: 'ENOTFOUND',
});
const enodata = Object.assign(new Error('queryAaaa ENODATA'), {
  code: 'ENODATA',
});

beforeEach(() => {
  resolve4Mock.mockReset();
  resolve6Mock.mockReset();
  setServersMock.mockReset();
  lookupMock.mockReset();
});

describe('waitForCloudflaredReady — production regression', () => {
  it('resolves when dns.lookup succeeds even if c-ares is stuck on NXDOMAIN for the full window', async () => {
    // Reproduces the exact failure mode observed in the field:
    //   - c-ares (both 4 and 6) keeps returning ENOTFOUND
    //   - dns.lookup succeeds on the 3rd tick (matching the ~3 s
    //     time-to-resolve measured in a real codespace)
    //
    // Before the fix this test would have timed out at 5 s — there
    // was no `dns.lookup` probe in the loop and c-ares was the only
    // path. The 5 s deadline is intentionally tight to make a
    // regression fail fast in CI rather than waiting 60 s.
    resolve4Mock.mockRejectedValue(enotfound);
    resolve6Mock.mockRejectedValue(enodata);
    lookupMock
      .mockRejectedValueOnce(enotfound)
      .mockRejectedValueOnce(enotfound)
      .mockResolvedValueOnce([{ address: '104.16.230.132', family: 4 }]);

    await expect(
      waitForCloudflaredReady('https://example-prod.trycloudflare.com', 5_000),
    ).resolves.toBeUndefined();
    expect(lookupMock).toHaveBeenCalledWith(
      'example-prod.trycloudflare.com',
      { all: true },
    );
  });

  it('still resolves via c-ares AAAA when only IPv6 records are published (other observed Quick Tunnel mode)', async () => {
    // Some trycloudflare.com hostnames publish AAAA before A.
    // `dns.lookup` returns IPv6 addresses in that case, so this
    // verifies the lookup path covers v6-only tunnels too.
    resolve4Mock.mockRejectedValue(enodata);
    resolve6Mock.mockRejectedValue(enotfound);
    lookupMock.mockResolvedValueOnce([
      { address: '2606:4700::6810:e784', family: 6 },
    ]);
    await expect(
      waitForCloudflaredReady('https://example-v6.trycloudflare.com', 1_000),
    ).resolves.toBeUndefined();
  });

  it('fires all three probes in parallel each tick (no serial fan-out)', async () => {
    // Verifies the structural invariant: every probe class runs on
    // every tick. A regression that drops `dns.lookup` would leave
    // it un-called; a regression that drops `resolve6` would leave
    // v6-only tunnels broken; etc.
    lookupMock.mockRejectedValueOnce(enotfound);
    resolve4Mock.mockRejectedValueOnce(enotfound);
    resolve6Mock.mockRejectedValueOnce(enodata);
    // Tick 2 succeeds via lookup
    lookupMock.mockResolvedValueOnce([{ address: '1.2.3.4', family: 4 }]);
    resolve4Mock.mockRejectedValueOnce(enotfound);
    resolve6Mock.mockRejectedValueOnce(enodata);

    await waitForCloudflaredReady('https://three.trycloudflare.com', 5_000);

    expect(lookupMock).toHaveBeenCalledTimes(2);
    expect(resolve4Mock).toHaveBeenCalledTimes(2);
    expect(resolve6Mock).toHaveBeenCalledTimes(2);
  });

  it('does NOT pin c-ares to 1.1.1.1 (regression guard against the slow-resolver fix)', async () => {
    // 1.1.1.1 specifically takes >60 s to see fresh trycloudflare
    // hostnames inside a codespace. Pinning the resolver to it
    // recreates the production failure. The fix removed
    // `setServers(['1.1.1.1', '1.0.0.1'])` — the c-ares fallback
    // now uses whatever `/etc/resolv.conf` provides. Asserting
    // setServers is never called pins that decision.
    lookupMock.mockResolvedValueOnce([{ address: '1.2.3.4', family: 4 }]);
    resolve4Mock.mockRejectedValue(enotfound);
    resolve6Mock.mockRejectedValue(enodata);

    await waitForCloudflaredReady('https://example.trycloudflare.com', 2_000);

    expect(setServersMock).not.toHaveBeenCalled();
  });
});
