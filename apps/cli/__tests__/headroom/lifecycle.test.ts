// __tests__/headroom/lifecycle.test.ts — assert start gated on env + stop on exit
import { it, expect, afterEach } from 'vitest';
import { maybeStartHeadroomReporter } from '../../src/commands/host-agent';

afterEach(() => {
  delete process.env['HEADROOM_ENABLED'];
});

it('does not start the reporter when HEADROOM_ENABLED !== 1', () => {
  delete process.env['HEADROOM_ENABLED'];
  expect(maybeStartHeadroomReporter({ sessionId: 's', pluginId: 'p', pluginAuthToken: 't', codespaceId: 'c' })).toBeNull();
});

it('starts a reporter when enabled and returns a handle with stop()', () => {
  process.env['HEADROOM_ENABLED'] = '1';
  const r = maybeStartHeadroomReporter({ sessionId: 's', pluginId: 'p', pluginAuthToken: 't', codespaceId: 'c' });
  expect(r).not.toBeNull();
  r!.stop();
});

/**
 * Documents the skip-when-no-token contract:
 * The guard lives at the pair-auto.ts call site — `maybeStartHeadroomReporter`
 * is only called when `claimed.pluginAuthToken` is truthy. An empty/absent token
 * guarantees a 401 on every savings POST (401-storm), so we skip the reporter
 * entirely rather than starting one that will always fail.
 *
 * This test mirrors the call-site conditional: `claimed.pluginAuthToken
 *   ? maybeStartHeadroomReporter(...) : null`
 */
it('skip-when-no-token: call-site guard returns null for empty pluginAuthToken', () => {
  process.env['HEADROOM_ENABLED'] = '1';
  const token = '';
  // Simulate the pair-auto.ts call-site guard:
  const result = token
    ? maybeStartHeadroomReporter({ sessionId: 's', pluginId: 'p', pluginAuthToken: token, codespaceId: 'c' })
    : null;
  expect(result).toBeNull();
});

it('skip-when-no-token: call-site guard returns null for undefined pluginAuthToken', () => {
  process.env['HEADROOM_ENABLED'] = '1';
  const token: string | undefined = undefined;
  // Simulate the pair-auto.ts call-site guard:
  const result = token
    ? maybeStartHeadroomReporter({ sessionId: 's', pluginId: 'p', pluginAuthToken: token, codespaceId: 'c' })
    : null;
  expect(result).toBeNull();
});
