import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sanitizeRetiredProxyConfig } from '../../src/agents/retired-proxy-cleanup';

let home: string;
const settings = () => path.join(home, '.claude', 'settings.json');
const write = (o: unknown) => {
  fs.mkdirSync(path.dirname(settings()), { recursive: true });
  fs.writeFileSync(settings(), JSON.stringify(o, null, 2));
};
const read = () => JSON.parse(fs.readFileSync(settings(), 'utf8'));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-home-'));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('sanitizeRetiredProxyConfig', () => {
  // The outage itself: Claude dialled 127.0.0.1:8787 on every turn and got
  // ConnectionRefused because Headroom was retired.
  it('removes the retired Headroom base URL', () => {
    write({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787', ENABLE_TOOL_SEARCH: 'true' } });
    const r = sanitizeRetiredProxyConfig(home);
    expect(r.changed).toBe(true);
    expect(r.removed).toContain('env.ANTHROPIC_BASE_URL');
    // The unrelated env key survives untouched.
    expect(read().env).toEqual({ ENABLE_TOOL_SEARCH: 'true' });
  });

  it.each([
    'http://localhost:8787',
    'http://127.0.0.1:8787/',
    'http://[::1]:8787',
    'HTTP://127.0.0.1:8787',
  ])('matches the retired proxy written as %s', (url) => {
    write({ env: { ANTHROPIC_BASE_URL: url } });
    expect(sanitizeRetiredProxyConfig(home).changed).toBe(true);
    expect(read().env).toBeUndefined();
  });

  // ⚠️ THE test. `ANTHROPIC_BASE_URL` is legitimate for the managed
  // agent-proxy and the house proxy — wiping those breaks paid inference.
  it.each([
    'https://api.codeagent-mobile.com/api/v1/agent-proxy',
    'http://127.0.0.1:8788',
    'https://127.0.0.1:8787.evil.example.com',
    'http://10.0.0.5:8787',
  ])('leaves a legitimate base URL alone: %s', (url) => {
    write({ env: { ANTHROPIC_BASE_URL: url } });
    const r = sanitizeRetiredProxyConfig(home);
    expect(r.changed).toBe(false);
    expect(read().env.ANTHROPIC_BASE_URL).toBe(url);
  });

  it('drops the headroom marketplace and hooks but keeps every other hook', () => {
    write({
      extraKnownMarketplaces: { 'headroom-marketplace': { source: { repo: 'chopratejas/headroom' } } },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ command: '/usr/local/bin/headroom init hook ensure' }] }],
        SessionStart: [
          { matcher: '', hooks: [{ command: 'bd prime --hook-json' }] },
          { matcher: 'startup|resume', hooks: [{ command: '/usr/local/bin/headroom init hook ensure' }] },
        ],
      },
    });
    const r = sanitizeRetiredProxyConfig(home);
    expect(r.changed).toBe(true);
    const after = read();
    expect(after.extraKnownMarketplaces).toBeUndefined();
    // PreToolUse held only the headroom hook → the whole event key goes.
    expect(after.hooks.PreToolUse).toBeUndefined();
    // SessionStart keeps beads and loses only the headroom group.
    expect(after.hooks.SessionStart).toEqual([
      { matcher: '', hooks: [{ command: 'bd prime --hook-json' }] },
    ]);
  });

  it('is idempotent — a second run changes nothing', () => {
    write({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' } });
    expect(sanitizeRetiredProxyConfig(home).changed).toBe(true);
    expect(sanitizeRetiredProxyConfig(home).changed).toBe(false);
  });

  // Must never block a session start.
  it('no-ops when the file is absent or malformed', () => {
    expect(sanitizeRetiredProxyConfig(home)).toEqual({ inspected: false, changed: false, removed: [] });
    fs.mkdirSync(path.dirname(settings()), { recursive: true });
    fs.writeFileSync(settings(), '{ not json');
    expect(sanitizeRetiredProxyConfig(home).changed).toBe(false);
  });

  it('leaves a clean settings.json byte-identical', () => {
    write({ env: { ENABLE_TOOL_SEARCH: 'true' }, hooks: { SessionStart: [{ hooks: [{ command: 'bd prime' }] }] } });
    const before = fs.readFileSync(settings(), 'utf8');
    expect(sanitizeRetiredProxyConfig(home).changed).toBe(false);
    expect(fs.readFileSync(settings(), 'utf8')).toBe(before);
  });
});
