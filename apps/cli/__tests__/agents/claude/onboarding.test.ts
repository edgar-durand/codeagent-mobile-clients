import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureClaudeOnboarded } from '../../../src/agents/claude/onboarding';

// HOME + USERPROFILE both redirected so os.homedir() resolves to a throwaway
// dir on Linux/macOS + Windows CI shards (vi.spyOn(os,'homedir') is flaky on ESM).
let tmpHome: string;
let origHome: string | undefined;
let origUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-onboard-'));
  origHome = process.env.HOME;
  origUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});
afterEach(() => {
  process.env.HOME = origHome;
  process.env.USERPROFILE = origUserProfile;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const claudeJson = () => path.join(tmpHome, '.claude.json');
const read = () => JSON.parse(fs.readFileSync(claudeJson(), 'utf8')) as Record<string, unknown>;

describe('ensureClaudeOnboarded', () => {
  it('writes onboarding + theme flags when ~/.claude.json is absent', () => {
    ensureClaudeOnboarded();
    const c = read();
    expect(c.hasCompletedOnboarding).toBe(true);
    expect(typeof c.theme).toBe('string'); // a theme is set so the picker never shows
  });

  it('MERGES into an existing config — never clobbers bridged credentials', () => {
    fs.writeFileSync(
      claudeJson(),
      JSON.stringify({ oauthAccount: { id: 'keep-me' }, theme: 'light' }),
    );
    ensureClaudeOnboarded();
    const c = read();
    expect(c.hasCompletedOnboarding).toBe(true);
    expect(c.theme).toBe('light'); // existing theme preserved
    expect((c.oauthAccount as { id: string }).id).toBe('keep-me'); // creds preserved
  });

  it('is a no-op once onboarding is already complete (does not rewrite)', () => {
    fs.writeFileSync(
      claudeJson(),
      JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }),
    );
    const before = fs.statSync(claudeJson()).mtimeMs;
    ensureClaudeOnboarded();
    expect(fs.statSync(claudeJson()).mtimeMs).toBe(before); // untouched
  });
});
