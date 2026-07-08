/**
 * Regression: `pair-auto` (the automated, headless daemon) must NEVER be
 * classified as a local/interactive session — otherwise the session baton
 * engages the native TUI in a headless context and `runAcpSession` never runs,
 * so the synthesized `agent_banner` chunk never reaches the app.
 *
 * The E2E (`codeagent-mobile` api-v2 `cli-api-codespace-e2e`) caught this only
 * post-release; this unit test guards the invariant pre-release from the CLI
 * side. `readTokenFromArgs` publishes the `CODEAM_AUTO_TOKEN` auto-plane marker
 * so `isLocalSession()` returns false for pair-auto, regardless of whether the
 * caller set `CODESPACES` / `CODEAM_AUTO_APPROVE`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readTokenFromArgs } from '../src/commands/pair-auto';
import { isLocalSession } from '../src/baton/gate';

describe('pair-auto is never a local/baton session', () => {
  const orig = process.env.CODEAM_AUTO_TOKEN;
  afterEach(() => {
    if (orig === undefined) delete process.env.CODEAM_AUTO_TOKEN;
    else process.env.CODEAM_AUTO_TOKEN = orig;
  });

  it('resolving the pair-auto token publishes CODEAM_AUTO_TOKEN → isLocalSession() is false', () => {
    delete process.env.CODEAM_AUTO_TOKEN;
    // Baseline: with no markers a session reads as "local" (baton would engage).
    expect(isLocalSession({} as NodeJS.ProcessEnv)).toBe(true);

    const token = readTokenFromArgs(['--token=auto-abc123']);

    expect(token).toBe('auto-abc123');
    // The resolver marked the auto/headless plane...
    expect(process.env.CODEAM_AUTO_TOKEN).toBe('auto-abc123');
    // ...so the baton gate now skips this session (no native TUI in a daemon).
    expect(isLocalSession()).toBe(false);
  });

  it('a real local session (no pair-auto, no markers) stays local — baton still engages', () => {
    // The fix must NOT weaken the baton for genuine local `codeam pair` sessions,
    // which never run pair-auto and carry none of the headless markers.
    expect(isLocalSession({} as NodeJS.ProcessEnv)).toBe(true);
  });
});
