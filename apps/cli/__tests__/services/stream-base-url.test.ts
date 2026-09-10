/**
 * `resolveStreamBaseUrl` — the CLI half of the api/stream host split
 * (spec §4.2 "Client convention", plan 2026-09-10 Step 4).
 *
 * Route PATHS never change — only the base URL of the four stream routes.
 * The rule is deliberately tiny: the two known hosts map to their stream
 * sibling, an explicit override wins, and anything else (localhost, a
 * custom `CODEAM_API_URL`, an unknown host) stays on the api base so
 * self-hosted / dev-loop setups are byte-identical to before.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveStreamBaseUrl,
  resolveStreamBaseUrlFromEnv,
  shouldFallBackToApiHost,
  StreamHostSelector,
} from '../../src/services/stream-base-url';

describe('resolveStreamBaseUrl(apiBase, override?)', () => {
  it.each([
    ['https://api.codeagent-mobile.com', 'https://stream.codeagent-mobile.com'],
    ['https://api.codeagent-mobile.com/', 'https://stream.codeagent-mobile.com'],
    ['https://dev-api.codeagent-mobile.com', 'https://dev-stream.codeagent-mobile.com'],
    ['https://dev-api.codeagent-mobile.com/', 'https://dev-stream.codeagent-mobile.com'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['http://localhost:3000/', 'http://localhost:3000'],
    ['http://127.0.0.1:4567', 'http://127.0.0.1:4567'],
    ['https://api.example.com', 'https://api.example.com'],
    ['https://staging-api.codeagent-mobile.com', 'https://staging-api.codeagent-mobile.com'],
    ['https://api.codeagent-mobile.com.evil.com', 'https://api.codeagent-mobile.com.evil.com'],
    ['http://api.codeagent-mobile.com', 'http://api.codeagent-mobile.com'],
  ])('%s → %s', (apiBase, expected) => {
    expect(resolveStreamBaseUrl(apiBase)).toBe(expected);
  });

  it('an explicit override wins over the host rule, trailing slash trimmed', () => {
    expect(resolveStreamBaseUrl('https://api.codeagent-mobile.com', 'http://127.0.0.1:9')).toBe(
      'http://127.0.0.1:9',
    );
    expect(resolveStreamBaseUrl('http://localhost:3000', 'https://stream.example.com/')).toBe(
      'https://stream.example.com',
    );
  });

  it('a blank override is ignored (unset env var semantics)', () => {
    expect(resolveStreamBaseUrl('https://api.codeagent-mobile.com', '  ')).toBe(
      'https://stream.codeagent-mobile.com',
    );
    expect(resolveStreamBaseUrl('https://api.codeagent-mobile.com', '')).toBe(
      'https://stream.codeagent-mobile.com',
    );
  });
});

describe('resolveStreamBaseUrlFromEnv — CODEAM_STREAM_URL next to CODEAM_API_URL', () => {
  const saved = { ...process.env };
  afterEach(() => {
    delete process.env.CODEAM_STREAM_URL;
    delete process.env.CODEAM_API_URL;
    delete process.env.CODEAM_TEST_MODE;
    if (saved.CODEAM_API_URL) process.env.CODEAM_API_URL = saved.CODEAM_API_URL;
  });

  it('prod default → prod stream host', () => {
    delete process.env.CODEAM_API_URL;
    delete process.env.CODEAM_TEST_MODE;
    expect(resolveStreamBaseUrlFromEnv()).toBe('https://stream.codeagent-mobile.com');
  });

  it('CODEAM_TEST_MODE=1 (dev api) → dev stream host', () => {
    delete process.env.CODEAM_API_URL;
    process.env.CODEAM_TEST_MODE = '1';
    expect(resolveStreamBaseUrlFromEnv()).toBe('https://dev-stream.codeagent-mobile.com');
  });

  it('a custom CODEAM_API_URL keeps streams on that same base', () => {
    process.env.CODEAM_API_URL = 'http://localhost:3000';
    expect(resolveStreamBaseUrlFromEnv()).toBe('http://localhost:3000');
  });

  it('CODEAM_STREAM_URL wins over everything', () => {
    process.env.CODEAM_API_URL = 'http://localhost:3000';
    process.env.CODEAM_STREAM_URL = 'http://localhost:3001/';
    expect(resolveStreamBaseUrlFromEnv()).toBe('http://localhost:3001');
  });
});

describe('shouldFallBackToApiHost — the one-time fallback verdict', () => {
  it.each([
    [{ kind: 'network' as const }, false, true],
    [{ kind: 'status' as const, status: 500 }, false, true],
    [{ kind: 'status' as const, status: 502 }, false, true],
    [{ kind: 'status' as const, status: 525 }, false, true], // Cloudflare: no origin cert yet
    [{ kind: 'status' as const, status: 401 }, false, false],
    [{ kind: 'status' as const, status: 403 }, false, false],
    [{ kind: 'status' as const, status: 404 }, false, false], // an `api`-role tier — never mask it
    [{ kind: 'status' as const, status: 400 }, false, false],
    [{ kind: 'status' as const, status: 429 }, false, false],
    [{ kind: 'network' as const }, true, false], // delivered-then-dropped → normal reconnect
    [{ kind: 'status' as const, status: 503 }, true, false],
  ])('%o delivered=%s → %s', (failure, delivered, expected) => {
    expect(shouldFallBackToApiHost(failure, delivered)).toBe(expected);
  });
});

describe('StreamHostSelector — process-wide latch shared by every SSE subscriber', () => {
  it('starts on the stream host and latches onto the api host after one qualifying failure', () => {
    const sel = new StreamHostSelector('https://api.x', 'https://stream.x');
    expect(sel.current).toBe('https://stream.x');
    expect(sel.fellBack).toBe(false);

    // 401 before delivery: not a fallback verdict.
    expect(sel.fallBackToApiHost({ kind: 'status', status: 401 }, false)).toBe(false);
    expect(sel.current).toBe('https://stream.x');

    // 5xx before delivery: switch — and report the switch exactly once.
    expect(sel.fallBackToApiHost({ kind: 'status', status: 503 }, false)).toBe(true);
    expect(sel.current).toBe('https://api.x');
    expect(sel.fellBack).toBe(true);

    // Already on the api host: nothing left to fall back to.
    expect(sel.fallBackToApiHost({ kind: 'network' }, false)).toBe(false);
    expect(sel.current).toBe('https://api.x');
  });

  it('is a no-op when the stream base equals the api base (localhost / custom / unknown host)', () => {
    const sel = new StreamHostSelector('http://localhost:3000', 'http://localhost:3000');
    expect(sel.current).toBe('http://localhost:3000');
    expect(sel.fallBackToApiHost({ kind: 'network' }, false)).toBe(false);
    expect(sel.fellBack).toBe(false);
  });
});
