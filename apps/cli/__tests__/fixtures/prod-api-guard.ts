// __tests__/fixtures/prod-api-guard.ts
//
// Global vitest setup file (vitest.config.ts `setupFiles`): fails any test
// that lets a `fetch` reach a real (non-loopback) host.
//
// ⚠️ WHY. Specs boot real code paths with fake sessions (`sess-1` /
// `plugin-1`). Every best-effort call those paths made without a mock went to
// `https://api.codeagent-mobile.com` from every local and CI run: ~1.5k prod
// 401s/day on /api/commands/send, scratch, baton state, credits and
// project-env (codeagent-1rhl), and 855 of the 870 prod 401s on the manifest
// refresh (codeagent-d5an). The calls swallow errors, so no test noticed, and
// they hid the real prod 401 ratio.
//
// The original `fetch` is wrapped once per test file, not spied, so a spec's
// own `vi.spyOn(globalThis, 'fetch')` / `vi.stubGlobal('fetch', …)` layers on
// top and restores back to this guard. A blocked request answers 503, so
// best-effort callers take their offline path, and the test that sent it
// fails. Loopback stays open for specs that run an in-test HTTP server.
import { afterAll, afterEach, expect } from 'vitest';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isRealHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return !LOOPBACK_HOSTS.has(parsed.hostname) && !parsed.hostname.endsWith('.localhost');
}

const realFetch = globalThis.fetch;
const hits: string[] = [];

globalThis.fetch = async function guardedFetch(input, init) {
  const url = urlOf(input);
  if (isRealHost(url)) {
    hits.push(url);
    return new Response('{}', { status: 503 });
  }
  return realFetch(input, init);
} as typeof fetch;

afterEach(() => {
  const sent = hits.splice(0);
  expect(
    sent,
    `this test sent requests to a real host; mock the HTTP layer: ${sent.join(', ')}`,
  ).toEqual([]);
});

// Catches fire-and-forget calls that land after the last test of the file.
afterAll(() => {
  const sent = hits.splice(0);
  expect(
    sent,
    `requests to a real host after the last test; mock the HTTP layer: ${sent.join(', ')}`,
  ).toEqual([]);
});
