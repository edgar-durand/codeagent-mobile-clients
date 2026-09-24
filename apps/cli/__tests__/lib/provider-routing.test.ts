import { describe, expect, it } from 'vitest';
import {
  classifyProviderBilling,
  describeProviderRouting,
  formatProviderRouting,
  matchesProviderBilling,
  readOpencodeProviderOrigins,
  redactUrlToOrigin,
  scrubSecrets,
} from '../../src/lib/provider-routing';

// codeagent-tvqt: a provider-side 402 must be attributable from the debug log
// alone — which endpoint the agent was routed to, redacted to scheme+host.

describe('redactUrlToOrigin', () => {
  it('keeps scheme + host (+ non-default port) and drops path, query, fragment, userinfo', () => {
    expect(redactUrlToOrigin('https://api.anthropic.com')).toBe('https://api.anthropic.com');
    expect(
      redactUrlToOrigin('https://user:sk-live-SECRET@proxy.example.com:8443/v1?api_key=sk-abc#frag'),
    ).toBe('https://proxy.example.com:8443');
    expect(redactUrlToOrigin('http://127.0.0.1:8787/api/v1/agent-proxy')).toBe('http://127.0.0.1:8787');
  });

  it('returns null for unset/empty and a literal marker for garbage', () => {
    expect(redactUrlToOrigin(undefined)).toBeNull();
    expect(redactUrlToOrigin('')).toBeNull();
    expect(redactUrlToOrigin('   ')).toBeNull();
    expect(redactUrlToOrigin('not a url')).toBe('invalid-url');
  });
});

describe('describeProviderRouting / formatProviderRouting', () => {
  const noConfig = { readFile: () => { throw new Error('ENOENT'); }, homeDir: '/nonexistent' };

  it('reports default for unset providers and redacted origins for set ones', () => {
    const r = describeProviderRouting(
      {
        ANTHROPIC_BASE_URL: 'https://api.deepinfra.com/v1/openai?key=sk-SHOULD-NOT-APPEAR',
        OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      },
      noConfig,
    );
    expect(r.env.ANTHROPIC_BASE_URL).toBe('https://api.deepinfra.com');
    expect(r.env.OPENAI_BASE_URL).toBe('https://openrouter.ai');
    expect(r.env.GEMINI_API_BASE).toBe('default');
    expect(r.houseProxy).toBe(false);
    const line = formatProviderRouting(r, 'claude');
    expect(line).toContain('agent=claude');
    expect(line).toContain('anthropic=https://api.deepinfra.com');
    expect(line).toContain('openai=https://openrouter.ai');
    expect(line).toContain('gemini=default');
    expect(line).not.toContain('sk-SHOULD-NOT-APPEAR');
    expect(line).not.toContain('/v1');
  });

  it('flags the house proxy and lists env KEY NAMES only (never values)', () => {
    const r = describeProviderRouting(
      {
        ANTHROPIC_BASE_URL: 'https://api.codeagent-mobile.com/api/v1/agent-proxy',
        ANTHROPIC_AUTH_TOKEN: 'house-token-value-MUST-NOT-LEAK',
        CODEAM_AUTO_TOKEN: 'auto-token-MUST-NOT-LEAK',
        CODEAM_EMPTY: '',
      },
      noConfig,
    );
    expect(r.houseProxy).toBe(true);
    expect(r.houseKeys).toEqual(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);
    expect(r.codeamKeys).toEqual(['CODEAM_AUTO_TOKEN']);
    const line = formatProviderRouting(r);
    expect(line).toContain('houseProxy=yes');
    expect(line).toContain('houseKeys=[ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN]');
    expect(line).toContain('codeamKeys=[CODEAM_AUTO_TOKEN]');
    expect(line).not.toContain('MUST-NOT-LEAK');
    expect(line).not.toContain('agent-proxy'); // path stripped
  });

  it('never throws when the opencode config reader blows up', () => {
    expect(() =>
      describeProviderRouting({}, { readFile: () => { throw new TypeError('boom'); }, homeDir: '/x' }),
    ).not.toThrow();
  });
});

describe('readOpencodeProviderOrigins', () => {
  it('reads provider.<id>.options.baseURL from project then global config, redacted, project wins', () => {
    const files: Record<string, string> = {
      '/repo/opencode.jsonc':
        '// project config\n{"provider":{"openrouter":{"options":{"baseURL":"https://openrouter.ai/api/v1?k=sk-x"}}}}',
      '/home/u/.config/opencode/opencode.json':
        '{"provider":{"openrouter":{"options":{"baseURL":"https://global.example.com/v1"}},"deepinfra":{"options":{"baseUrl":"https://api.deepinfra.com/v1/openai"}}}}',
    };
    const out = readOpencodeProviderOrigins({
      cwd: '/repo',
      homeDir: '/home/u',
      readFile: (f) => {
        if (f in files) return files[f];
        throw new Error('ENOENT');
      },
    });
    expect(out).toEqual([
      { provider: 'openrouter', origin: 'https://openrouter.ai' },
      { provider: 'deepinfra', origin: 'https://api.deepinfra.com' },
    ]);
  });

  it('skips unparsable files and yields [] when nothing is configured', () => {
    expect(
      readOpencodeProviderOrigins({
        cwd: '/repo',
        homeDir: '/home/u',
        readFile: (f) => (f.endsWith('opencode.json') ? '{not json' : (() => { throw new Error('ENOENT'); })()),
      }),
    ).toEqual([]);
  });
});

describe('matchesProviderBilling', () => {
  it.each([
    'API Error: 402 Insufficient credits',
    'Failed to authenticate. API Error: 402 {"error":"insufficient balance (1008)"}',
    'status 402 Payment Required',
    'Error: Insufficient credits — top up at openrouter.ai',
    'upstream said: insufficient funds',
  ])('matches %j', (line) => {
    expect(matchesProviderBilling(line)).toBe(true);
  });

  it.each([
    'API Error: 401 Unauthorized',
    'HTTP 403 HOUSE_AGENT_CEILING',
    'issue #402 closed',
    'at line 402 of runner.ts',
    'Insufficient permissions for repo',
  ])('does not match %j', (line) => {
    expect(matchesProviderBilling(line)).toBe(false);
  });
});

describe('classifyProviderBilling', () => {
  it('is null without a billing signal', () => {
    expect(classifyProviderBilling('all good', {})).toBeNull();
  });

  it('is EXTERNAL when the env is not our house proxy (the codeagent-tvqt case)', () => {
    const m = classifyProviderBilling('API Error: 402 Insufficient credits', {
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1',
    });
    expect(m).toEqual({
      marker: 'provider_billing_external',
      anthropicHost: 'https://openrouter.ai',
      snippet: 'API Error: 402 Insufficient credits',
    });
  });

  it('is EXTERNAL with anthropicHost=default when no base URL is set', () => {
    expect(classifyProviderBilling('API Error: 402 Insufficient credits', {})).toMatchObject({
      marker: 'provider_billing_external',
      anthropicHost: 'default',
    });
  });

  it('is HOUSE when routed through our agent-proxy', () => {
    const m = classifyProviderBilling('API Error: 402 insufficient balance', {
      ANTHROPIC_BASE_URL: 'https://api.codeagent-mobile.com/api/v1/agent-proxy',
      ANTHROPIC_AUTH_TOKEN: 'tok',
    });
    expect(m?.marker).toBe('provider_billing_house');
    expect(m?.anthropicHost).toBe('https://api.codeagent-mobile.com');
  });

  it('picks the matching line out of a multi-line text and scrubs key-shaped tokens', () => {
    const m = classifyProviderBilling(
      'Thinking…\nAPI Error: 402 Insufficient credits key=sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789\ndone',
      {},
    );
    expect(m?.snippet.startsWith('API Error: 402 Insufficient credits')).toBe(true);
    expect(m?.snippet).not.toContain('abcdefghijklmnop');
    expect(m?.snippet.length).toBeLessThanOrEqual(160);
  });
});

describe('scrubSecrets', () => {
  it('redacts sk-/key-/token- prefixed strings, bearer tokens and long opaque blobs', () => {
    const s = scrubSecrets(
      'sk-ant-api03-ABCDEFGHIJKLMNOP Bearer abcdefghijklmnopqrstuvwxyz ' +
        'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ short',
    );
    expect(s).not.toContain('ABCDEFGHIJKLMNOP');
    expect(s).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(s).not.toContain('ZZZZZZZZZZ');
    expect(s).toContain('short');
  });
});
