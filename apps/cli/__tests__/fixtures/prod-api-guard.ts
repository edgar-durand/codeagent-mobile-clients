// __tests__/fixtures/prod-api-guard.ts
//
// Fails a test that lets a real request reach the production API.
//
// ⚠️ WHY. The `start()` specs boot the real start path with a fake session
// (`sess-1` / `plugin-1`). Every best-effort call that path makes without a
// mock went to `https://api.codeagent-mobile.com` from every local and CI run.
// On 2026-10-09/10, 855 of the 870 prod 401s on
// `POST /api/plugin/integrations/manifest` were these specs (the session-start
// manifest refresh), which hid the real ratio of the MCP tool-router rollout.
// The calls are best-effort and swallow errors, so a test never noticed.
//
// `guardProdApi()` stubs `fetch` for the file (503, so best-effort callers
// take their offline path) and fails the test that sent anything to the
// production API base.
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { resolveApiBaseUrl } from '@codeam/shared';

export function guardProdApi(): void {
  const prodBase = resolveApiBaseUrl();
  const hits: string[] = [];
  let spy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    hits.length = 0;
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(prodBase)) hits.push(url);
      return new Response('{}', { status: 503 });
    });
  });

  afterEach(() => {
    spy?.mockRestore();
    expect(hits, 'this test sent requests to the production API').toEqual([]);
  });
}
