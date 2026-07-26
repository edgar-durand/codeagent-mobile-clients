import { describe, it, expect } from 'vitest';
import { buildHttpHeaders, fillTemplate } from '../../src/integrations/http-relay';
import type { BrokeredIntegrationToken } from '@codeam/shared';

const token = (over: Partial<BrokeredIntegrationToken> = {}): BrokeredIntegrationToken => ({
  accessToken: 'phx_secret_key',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  ...over,
});

describe('buildHttpHeaders', () => {
  it('fills {field} placeholders from the brokered token', () => {
    expect(
      buildHttpHeaders({ Authorization: 'Bearer {accessToken}' }, token()),
    ).toEqual({ Authorization: 'Bearer phx_secret_key' });
  });

  it('supports multiple headers + fields', () => {
    expect(
      buildHttpHeaders(
        { Authorization: 'Bearer {accessToken}', 'X-Guild': '{guildId}' },
        token({ guildId: 'g123' }),
      ),
    ).toEqual({ Authorization: 'Bearer phx_secret_key', 'X-Guild': 'g123' });
  });

  it('substitutes a missing field with empty string (never leaks the placeholder)', () => {
    expect(buildHttpHeaders({ 'X-Org': '{orgUrl}' }, token())).toEqual({ 'X-Org': '' });
  });

  it('returns {} for no header templates', () => {
    expect(buildHttpHeaders(undefined, token())).toEqual({});
  });
});

describe('fillTemplate', () => {
  it('templates a per-user host into a URL (Datadog regional site)', () => {
    expect(
      fillTemplate('https://mcp.{host}/api/unstable/mcp-server/mcp', token({ host: 'datadoghq.eu' })),
    ).toBe('https://mcp.datadoghq.eu/api/unstable/mcp-server/mcp');
  });

  it('leaves a URL with no placeholders unchanged', () => {
    expect(fillTemplate('https://mcp.posthog.com/mcp', token())).toBe('https://mcp.posthog.com/mcp');
  });
});
