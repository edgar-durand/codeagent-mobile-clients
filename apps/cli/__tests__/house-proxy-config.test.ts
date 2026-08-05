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
