/**
 * Integration test — production /api/pairing/pair reachability.
 *
 * Why this exists
 * ---------------
 * We just shipped a fix for the default `CODEAM_API_URL` after prod migrated
 * from Vercel to Cloud Run (`api.codeagent-mobile.com`). The user-visible
 * symptom of the bug was `codeam pair` printing:
 *
 *     ✗ Could not reach the server. Check your connection and try again.
 *
 * This test exists to catch any future regression where the default points
 * at a dead host. It POSTs a deliberately-invalid payload to the real
 * production `/api/pairing/pair` endpoint and asserts that the API
 * responded over HTTP — i.e. we got a structured JSON error back, not a
 * DNS / TLS / connection error.
 *
 * What "pass" means
 * -----------------
 * - DNS resolves, TLS handshake completes, the server responds with any
 *   HTTP status code and a parseable JSON body.
 * - Pairing itself does NOT have to succeed — we expect the server to
 *   reject the invalid payload (probably 400). We only care that the
 *   network round-trip works.
 *
 * What "fail" means
 * -----------------
 * - The fetch throws (DNS failure, ECONNREFUSED, TLS error, timeout).
 * - The server returns 403 (which is what dead/protected Vercel
 *   deployments return — that's the bug we're guarding against).
 * - The response body is unparseable (suggests we hit something that
 *   isn't actually the API).
 *
 * How to run
 * ----------
 * Gated behind an env var so the default `npm test` run isn't flaky on
 * machines without internet access. CI opts in by setting the var.
 *
 *     CODEAM_RUN_INTEGRATION_TESTS=1 npm test -- --testPathPatterns=pair-prod
 *
 * Override target URL (e.g. against staging):
 *
 *     CODEAM_RUN_INTEGRATION_TESTS=1 CODEAM_API_URL=https://staging.example.com \
 *         npm test -- --testPathPatterns=pair-prod
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_API_BASE_URL } from '@codeagent/shared';

const RUN = process.env.CODEAM_RUN_INTEGRATION_TESTS === '1';
// Use the shared constant — if the canonical prod URL ever drifts from this
// test target, this assertion fails fast and the CI catches it.
const API_BASE = process.env.CODEAM_API_URL ?? DEFAULT_API_BASE_URL;
const PAIR_URL = `${API_BASE}/api/pairing/pair`;
const TIMEOUT_MS = 10_000;

// Conditional describe — without the env var, the whole block is skipped
// and `npm test` stays offline-friendly.
const d = RUN ? describe : describe.skip;

d('integration: prod /api/pairing/pair reachability', () => {
  it(
    'POST to ' + PAIR_URL + ' returns a structured HTTP response (not a connection error)',
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      let status: number | null = null;
      let body: string | null = null;
      let parseError: unknown = null;
      let networkError: unknown = null;

      try {
        const res = await fetch(PAIR_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Codeam-Protocol-Version': '2.0.0',
            // Identify this traffic in server logs so it's easy to grep out.
            'User-Agent': 'codeam-cli-integration-test/1.0',
          },
          // Intentionally invalid payload — we want the server to *reject*
          // it (400), proving the request reached the API layer. A valid
          // shape would consume a real pairing code.
          body: JSON.stringify({
            pluginId: 'integration-test-invalid-' + Date.now(),
            invalid_marker: true,
          }),
          signal: controller.signal,
        });

        status = res.status;
        body = await res.text();
      } catch (err) {
        networkError = err;
      } finally {
        clearTimeout(timer);
      }

      // Loud diagnostic — if this test fails, you want the URL and the
      // exact error visible in the CI log without re-running.
      if (networkError) {
        // eslint-disable-next-line no-console
        console.error(
          `[pair-prod] NETWORK ERROR contacting ${PAIR_URL}:`,
          networkError instanceof Error ? networkError.message : networkError,
        );
      }

      // Assertion 1 — the request must have completed at the HTTP layer.
      // DNS failure / TLS / ECONNREFUSED / timeout all surface here.
      expect(
        networkError,
        `Could not reach ${PAIR_URL} — this is the exact bug we're guarding against. ` +
          `Underlying error: ${
            networkError instanceof Error ? networkError.message : String(networkError)
          }`,
      ).toBeNull();

      // Assertion 2 — we got *some* HTTP status. Anything in 100–599 is fine
      // for proving reachability.
      expect(status).not.toBeNull();
      expect(status).toBeGreaterThanOrEqual(100);
      expect(status).toBeLessThan(600);

      // Assertion 3 — guard specifically against the Vercel "deployment
      // protected" 403 page, which is what the OLD prod URL returns now
      // and the original symptom of this bug.
      expect(
        status,
        `Got 403 from ${PAIR_URL} — looks like a gated Vercel deployment. ` +
          `Did the default URL regress back to the old Vercel host? Body was: ${body?.slice(0, 200)}`,
      ).not.toBe(403);

      // Assertion 4 — the body parses as JSON. This rules out hitting
      // a CDN error page or a non-API host that happens to answer.
      try {
        JSON.parse(body ?? '');
      } catch (e) {
        parseError = e;
      }
      expect(
        parseError,
        `Response from ${PAIR_URL} is not JSON. Status=${status}, body head=${body?.slice(0, 200)}`,
      ).toBeNull();

      // If we got here, the test passed — make it visible in the
      // log so an operator can see at a glance "yes, prod is alive".
      // eslint-disable-next-line no-console
      console.log(`✓ prod /api/pairing/pair reachable (status=${status})`);
    },
    TIMEOUT_MS + 2_000,
  );
});
