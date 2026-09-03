/**
 * Regression (Rafael, 2026-08-05): a warm-codespace house-agent session that
 * worked at deploy failed with "Authentication required" after a sleep/wake,
 * because the RESUME (bare `codeam`) re-injected the Headroom env but NOT the
 * house-proxy env — so the woken Claude agent had no ANTHROPIC_BASE_URL /
 * AUTH_TOKEN. This suite locks the persist → read → child-env round-trip that
 * makes the house-proxy env survive a resume (mirrors headroom-config).
 *
 * WHY IT WASN'T CAUGHT BEFORE: the house-proxy env only ever existed in the
 * deploy-time childEnv; there was no persist/read module for it, so no test
 * could assert a resume re-injects it. This module + spec close that gap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

// `os.homedir()` can't be spied in ESM (namespace non-configurable), so mock the
// module and route homedir at a mutable holder we swap per test.
const homeHolder = vi.hoisted(() => ({ dir: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, default: actual, homedir: () => homeHolder.dir };
});

import {
  persistHouseProxyConfig,
  readHouseProxyChildEnv,
  clearHouseProxyConfig,
  houseProxyConfigPath,
  buildHouseProxyChildEnv,
  clearHouseProxyEnvOverrides,
  isHouseProxyEnv,
  pickHouseProxyEnv,
  HOUSE_PROXY_ENV_KEYS,
  HOUSE_MODEL_CONTEXT_TOKENS,
} from '../src/commands/host/house-proxy-config';

let tmpHome: string;

describe('house-proxy-config — resume env persistence', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'house-proxy-'));
    homeHolder.dir = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('round-trips a CodeAgent Cloud (house) config into the child env with the MiniMax pins', () => {
    persistHouseProxyConfig({
      baseUrl: 'https://api.codeagent-mobile.com/api/v1/agent-proxy',
      token: 'proxy-tok-abc',
      claudeConfigDir: '/home/box/.codeam/house-claude/dep-1',
    });
    const env = readHouseProxyChildEnv();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.codeagent-mobile.com/api/v1/agent-proxy');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('proxy-tok-abc');
    expect(env.ANTHROPIC_MODEL).toBe('MiniMax-M3');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('MiniMax-M3');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/box/.codeam/house-claude/dep-1');
    // House pins a model — it must NOT blank ANTHROPIC_API_KEY (that's OpenRouter only).
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.API_TIMEOUT_MS).toBe('3000000');
  });

  it('round-trips an OpenRouter gateway config with ANTHROPIC_API_KEY="" and NO model pins', () => {
    persistHouseProxyConfig({
      baseUrl: 'https://openrouter.ai/api',
      token: 'sk-or-v1-xyz',
      openRouter: true,
    });
    const env = readHouseProxyChildEnv();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-or-v1-xyz');
    expect(env.ANTHROPIC_API_KEY).toBe(''); // required so a stale key can't override the Bearer token
    expect(env.ANTHROPIC_MODEL).toBeUndefined(); // OpenRouter routes real model names
  });

  it('returns {} when no config is persisted (BYO-agent box → its own credential path)', () => {
    expect(readHouseProxyChildEnv()).toEqual({});
  });

  it('clearHouseProxyConfig removes the file so a later resume does NOT re-inject a stale house proxy', () => {
    persistHouseProxyConfig({ baseUrl: 'https://x/api/v1/agent-proxy', token: 't' });
    expect(fs.existsSync(houseProxyConfigPath())).toBe(true);
    clearHouseProxyConfig();
    expect(fs.existsSync(houseProxyConfigPath())).toBe(false);
    expect(readHouseProxyChildEnv()).toEqual({});
  });

  it('returns {} on a corrupt/half-written config (never throws into the resume path)', () => {
    fs.mkdirSync(path.dirname(houseProxyConfigPath()), { recursive: true });
    fs.writeFileSync(houseProxyConfigPath(), '{ not json');
    expect(readHouseProxyChildEnv()).toEqual({});
  });
});


// ── In-session switch helpers (house target / leaving house) ────────────────

describe('buildHouseProxyChildEnv', () => {
  it('house shape: proxy base URL + token + MiniMax pins + isolated config dir', () => {
    const env = buildHouseProxyChildEnv({
      baseUrl: 'https://api.example.com/api/v1/agent-proxy',
      token: 'proxy-jwt',
      claudeConfigDir: '/home/u/.codeam/house-claude/switch-p1',
    });
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.example.com/api/v1/agent-proxy',
      ANTHROPIC_AUTH_TOKEN: 'proxy-jwt',
      ANTHROPIC_MODEL: 'MiniMax-M3',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '512000',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '512000',
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CONFIG_DIR: '/home/u/.codeam/house-claude/switch-p1',
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  // ⚠️ The thrashing bug. claude does not know MiniMax-M3 and assumes its
  // unknown-model default (200k); CLAUDE_CODE_AUTO_COMPACT_WINDOW is applied as
  // Math.min(assumed, env), so on its own it can only SHRINK that — the 512000
  // we used to set was inert. With ~175k tokens of MCP tool schemas per turn the
  // context started ~88% full and compacted on a 28-character prompt, 13 times
  // in one session (2026-09-03). CLAUDE_CODE_MAX_CONTEXT_TOKENS is what claude
  // reads for an unrecognised model's REAL window ("set
  // CLAUDE_CODE_MAX_CONTEXT_TOKENS to its real window", its own notice).
  it('declares the REAL window for the unknown model, from ONE constant, so the two knobs cannot drift', () => {
    const env = buildHouseProxyChildEnv({ baseUrl: 'https://p/api/v1/agent-proxy', token: 't' });
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(HOUSE_MODEL_CONTEXT_TOKENS);
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(HOUSE_MODEL_CONTEXT_TOKENS);
    // MiniMax-M3: 1M advertised, 512K guaranteed minimum. Declaring MORE than
    // the guarantee would let claude overrun the provider; declaring the old
    // 200k default would recreate the thrash. Pin both bounds.
    expect(Number(HOUSE_MODEL_CONTEXT_TOKENS)).toBeGreaterThanOrEqual(512_000);
    expect(Number(HOUSE_MODEL_CONTEXT_TOKENS)).toBeLessThanOrEqual(1_000_000);
  });

  it('the OpenRouter gateway shape carries the same window knobs (same builder, same fix)', () => {
    const env = buildHouseProxyChildEnv({ baseUrl: 'https://p/api/v1/agent-proxy', token: 't', openRouter: true });
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(HOUSE_MODEL_CONTEXT_TOKENS);
    expect(env.ANTHROPIC_API_KEY).toBe('');
  });

  it('is the SAME env readHouseProxyChildEnv rebuilds from a persisted config', () => {
    const cfg = {
      baseUrl: 'https://api.example.com/api/v1/agent-proxy',
      token: 'proxy-jwt',
      claudeConfigDir: '/home/u/.codeam/house-claude/d1',
    };
    persistHouseProxyConfig(cfg);
    expect(readHouseProxyChildEnv()).toEqual(buildHouseProxyChildEnv(cfg));
  });
});

describe('isHouseProxyEnv / pickHouseProxyEnv', () => {
  it('detects the managed-proxy env a house deploy exports', () => {
    expect(
      isHouseProxyEnv({
        ANTHROPIC_BASE_URL: 'https://api.codeagent-mobile.com/api/v1/agent-proxy',
        ANTHROPIC_AUTH_TOKEN: 'jwt',
      }),
    ).toBe(true);
  });

  it("does NOT match a user's own custom ANTHROPIC_BASE_URL", () => {
    expect(
      isHouseProxyEnv({
        ANTHROPIC_BASE_URL: 'https://my-corp-gateway.example.com',
        ANTHROPIC_AUTH_TOKEN: 'jwt',
      }),
    ).toBe(false);
    expect(isHouseProxyEnv({})).toBe(false);
    expect(
      isHouseProxyEnv({ ANTHROPIC_BASE_URL: 'https://x/api/v1/agent-proxy' }),
    ).toBe(false); // no token → not a house process
  });

  it('pickHouseProxyEnv keeps only the house keys that are actually set', () => {
    const picked = pickHouseProxyEnv({
      ANTHROPIC_BASE_URL: 'https://x/api/v1/agent-proxy',
      ANTHROPIC_AUTH_TOKEN: 'jwt',
      ANTHROPIC_MODEL: 'MiniMax-M3',
      PATH: '/usr/bin',
      HOME: '/home/u',
    });
    expect(picked).toEqual({
      ANTHROPIC_BASE_URL: 'https://x/api/v1/agent-proxy',
      ANTHROPIC_AUTH_TOKEN: 'jwt',
      ANTHROPIC_MODEL: 'MiniMax-M3',
    });
  });
});

describe('clearHouseProxyEnvOverrides', () => {
  it('maps every house key to undefined so spawn DELETES it from the child env', () => {
    const overrides = clearHouseProxyEnvOverrides();
    expect(Object.keys(overrides).sort()).toEqual([...HOUSE_PROXY_ENV_KEYS].sort());
    for (const v of Object.values(overrides)) expect(v).toBeUndefined();
  });

  // ⚠️ THE guard for "house-agent only". Every key the house builder sets must
  // be in the clearing list, or a switch AWAY from the house agent to the user's
  // own Claude Code would inherit it. For MAX_CONTEXT_TOKENS that would mean
  // telling a REAL Anthropic model a made-up window — exactly the cross-
  // contamination this fix must never cause.
  it('every key the house builder sets is cleared on a switch away — the fix cannot leak to a user\'s own Claude', () => {
    const env = buildHouseProxyChildEnv({ baseUrl: 'https://p/api/v1/agent-proxy', token: 't', claudeConfigDir: '/x' });
    const cleared = new Set<string>(Object.keys(clearHouseProxyEnvOverrides()));
    for (const key of Object.keys(env)) {
      expect(cleared.has(key), `${key} is set by the house builder but NOT cleared on switch-away`).toBe(true);
    }
  });

  it('a later credential env WINS over the clearing layer (spread order contract)', () => {
    const merged: Record<string, string | undefined> = {
      ...clearHouseProxyEnvOverrides(),
      ANTHROPIC_API_KEY: 'sk-real',
    };
    expect(merged.ANTHROPIC_API_KEY).toBe('sk-real');
    expect(merged.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});
