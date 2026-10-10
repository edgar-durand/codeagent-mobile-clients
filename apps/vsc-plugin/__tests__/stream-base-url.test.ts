import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STREAM_BASE_URL,
  DEV_STREAM_BASE_URL,
  StreamHostSelector,
  resolveStreamBaseUrl,
  shouldFallBackToApiHost,
} from '../src/services/stream-base-url';

describe('resolveStreamBaseUrl', () => {
  it('maps prod and dev api hosts onto their stream hosts', () => {
    expect(resolveStreamBaseUrl('https://api.codeagent-mobile.com')).toBe(DEFAULT_STREAM_BASE_URL);
    expect(resolveStreamBaseUrl('https://api.codeagent-mobile.com/')).toBe(DEFAULT_STREAM_BASE_URL);
    expect(resolveStreamBaseUrl('https://dev-api.codeagent-mobile.com')).toBe(DEV_STREAM_BASE_URL);
  });

  it('leaves any other base untouched (self-hosted / localhost)', () => {
    expect(resolveStreamBaseUrl('http://localhost:3001/')).toBe('http://localhost:3001');
  });
});

describe('shouldFallBackToApiHost', () => {
  it('falls back on a network error or a 5xx before delivery', () => {
    expect(shouldFallBackToApiHost({ kind: 'network' }, false)).toBe(true);
    expect(shouldFallBackToApiHost({ kind: 'status', status: 525 }, false)).toBe(true);
  });

  it('never falls back on 4xx or after delivery', () => {
    expect(shouldFallBackToApiHost({ kind: 'status', status: 404 }, false)).toBe(false);
    expect(shouldFallBackToApiHost({ kind: 'status', status: 401 }, false)).toBe(false);
    expect(shouldFallBackToApiHost({ kind: 'network' }, true)).toBe(false);
  });
});

describe('StreamHostSelector', () => {
  const api = 'https://api.codeagent-mobile.com';

  it('latches onto the api host once, and re-derives when the api base changes', () => {
    const s = new StreamHostSelector();
    expect(s.currentFor(api)).toBe(DEFAULT_STREAM_BASE_URL);
    expect(s.fallBackToApiHost(api, { kind: 'status', status: 503 }, false)).toBe(true);
    expect(s.currentFor(api)).toBe(api);
    expect(s.fallBackToApiHost(api, { kind: 'network' }, false)).toBe(false);
    const dev = 'https://dev-api.codeagent-mobile.com';
    expect(s.currentFor(dev)).toBe(DEV_STREAM_BASE_URL);
  });

  it('has nothing to fall back to when stream base == api base', () => {
    const s = new StreamHostSelector();
    expect(s.fallBackToApiHost('http://localhost:3001', { kind: 'network' }, false)).toBe(false);
  });
});
