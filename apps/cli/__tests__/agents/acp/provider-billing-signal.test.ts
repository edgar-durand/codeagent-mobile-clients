import { beforeEach, describe, expect, it, vi } from 'vitest';

const { captureMock, warnMock } = vi.hoisted(() => ({
  captureMock: vi.fn(),
  warnMock: vi.fn(),
}));
vi.mock('../../../src/services/telemetry.service', () => ({ capture: captureMock }));
vi.mock('../../../src/services/logger', () => ({
  log: { warn: warnMock, info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

import {
  _resetProviderBillingSignalForTests,
  noteProviderBillingSignal,
} from '../../../src/agents/acp/provider-billing-signal';

// codeagent-tvqt: when an agent line reads like a provider 402 and the host in
// effect is NOT our proxy, the debug log gets a structured
// `provider_billing_external` marker and the CLI's existing telemetry channel
// (PostHog capture) gets the same typed event — no new backend endpoint.
describe('noteProviderBillingSignal', () => {
  beforeEach(() => {
    captureMock.mockClear();
    warnMock.mockClear();
    _resetProviderBillingSignalForTests();
  });

  it('writes one structured marker line + one typed event for an external 402 reply', () => {
    const m = noteProviderBillingSignal({
      text: 'API Error: 402 Insufficient credits',
      source: 'reply',
      agent: 'claude',
      env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1' },
    });
    expect(m?.marker).toBe('provider_billing_external');
    expect(warnMock).toHaveBeenCalledTimes(1);
    const [tag, line] = warnMock.mock.calls[0] as [string, string];
    expect(tag).toBe('providerBilling');
    expect(JSON.parse(line)).toEqual({
      marker: 'provider_billing_external',
      source: 'reply',
      agent: 'claude',
      anthropicHost: 'https://openrouter.ai',
      snippet: 'API Error: 402 Insufficient credits',
    });
    expect(captureMock).toHaveBeenCalledWith('provider_billing_external', {
      source: 'reply',
      agent: 'claude',
      anthropic_host: 'https://openrouter.ai',
    });
  });

  it('marks HOUSE when the process runs on our agent-proxy', () => {
    const m = noteProviderBillingSignal({
      text: 'API Error: 402 insufficient balance (1008)',
      source: 'stderr',
      agent: 'claude',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.codeagent-mobile.com/api/v1/agent-proxy',
        ANTHROPIC_AUTH_TOKEN: 'tok',
      },
    });
    expect(m?.marker).toBe('provider_billing_house');
    expect(captureMock).toHaveBeenCalledWith('provider_billing_house', expect.anything());
  });

  it('is silent for non-billing text', () => {
    expect(
      noteProviderBillingSignal({ text: 'Done. 3 files changed.', source: 'reply', agent: 'codex', env: {} }),
    ).toBeNull();
    expect(warnMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('dedupes per (marker, source) so a retry loop cannot spam the log', () => {
    for (let i = 0; i < 5; i++) {
      noteProviderBillingSignal({ text: 'API Error: 402 Insufficient credits', source: 'stderr', agent: 'claude', env: {} });
    }
    noteProviderBillingSignal({ text: 'API Error: 402 Insufficient credits', source: 'reply', agent: 'claude', env: {} });
    expect(warnMock).toHaveBeenCalledTimes(2); // stderr once + reply once
    expect(captureMock).toHaveBeenCalledTimes(2);
  });
});
