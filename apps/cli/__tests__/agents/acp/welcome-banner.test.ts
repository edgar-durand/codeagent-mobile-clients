import { describe, it, expect, vi, afterEach } from 'vitest';

import { bannerTitle, bannerLocation, buildBannerSubtitle } from '../../../src/agents/acp/runner';
import { _onboardingSeam } from '../../../src/agents/acp/onboarding';

afterEach(() => vi.restoreAllMocks());

describe('bannerTitle', () => {
  it('greets a BRAND-NEW conversation with "Welcome!"', () => {
    // Live bug: two first-time users were greeted with "Welcome back!" on the
    // very first session they ever opened.
    expect(bannerTitle(false)).toBe('Welcome!');
  });

  it('only says "Welcome back!" when a prior conversation was actually resumed', () => {
    expect(bannerTitle(true)).toBe('Welcome back!');
  });
});

describe('bannerLocation', () => {
  it('never surfaces the raw self-hosted cwd', () => {
    // The observed card literally read `/home/box/.codeam/self-hosted/<uuid>`.
    vi.spyOn(_onboardingSeam, 'gitRemoteUrl').mockReturnValue(
      'https://github.com/acme/widgets.git',
    );
    const line = bannerLocation(
      '/home/box/.codeam/self-hosted/3f9a1c02-aaaa-bbbb-cccc-ddddeeeeffff',
    );

    expect(line).toBe('Ready in widgets');
    expect(line).not.toContain('/home/box');
    expect(line).not.toContain('.codeam');
    expect(line).not.toContain('self-hosted');
  });

  it('never surfaces a UUID clone directory when there is no git remote', () => {
    vi.spyOn(_onboardingSeam, 'gitRemoteUrl').mockReturnValue(null);
    const line = bannerLocation('/workspaces/a2480d74-aaa4-442d-91cc-2a6c595b3560');

    expect(line).toBe('Ready in this project');
    expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('uses the checkout directory name when it is a real repo name', () => {
    vi.spyOn(_onboardingSeam, 'gitRemoteUrl').mockReturnValue(null);
    expect(bannerLocation('/workspaces/join-the-queue')).toBe('Ready in join-the-queue');
  });

  it('degrades to a generic label rather than an empty line', () => {
    vi.spyOn(_onboardingSeam, 'gitRemoteUrl').mockReturnValue(null);
    expect(bannerLocation('')).toBe('Ready in this project');
  });
});

describe('buildBannerSubtitle — never stringifies a non-string wire value', () => {
  it('renders "<agent> · <model> · <tier>" for well-formed values', () => {
    expect(buildBannerSubtitle('codex', 'abcdef1234', 'gpt-5', 'plus')).toBe(
      'Codex CLI · gpt-5 · plus',
    );
  });

  it('drops an EMPTY-ARRAY tier instead of emitting a dangling separator', () => {
    // `[]` is truthy and `String([])` is '' — this produced "… · default · ".
    const out = buildBannerSubtitle('cursor', 'abcdef1234', 'default', [] as unknown as string);
    expect(out).toBe('Cursor Agent · default');
    expect(out).not.toMatch(/·\s*$/);
  });

  it('never renders a stringified array for the model — the "default[]" bug', () => {
    const out = buildBannerSubtitle(
      'cursor',
      'abcdef1234',
      ['default'] as unknown as string,
      undefined,
    );
    expect(out).not.toContain('[');
    expect(out).not.toContain(']');
    expect(out).toBe('Cursor Agent · ACP · abcdef12');
  });

  it('treats a blank-string model as absent', () => {
    expect(buildBannerSubtitle('cursor', 'abcdef1234', '   ', undefined)).toBe(
      'Cursor Agent · ACP · abcdef12',
    );
  });
});
