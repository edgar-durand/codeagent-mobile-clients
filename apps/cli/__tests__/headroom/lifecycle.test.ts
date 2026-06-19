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
