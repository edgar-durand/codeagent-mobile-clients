import { describe, it, expect } from 'vitest';
import { detectStartupBanner } from '../../../src/agents/claude/parsing';

/**
 * Regression for Claude Code v2.1.152's welcome — it renders the
 * legacy 3-line block-art banner INSIDE a two-column box-drawn
 * frame ("│ ... │ Tips for getting started" on the same row). The
 * earlier detector required the art line to START with `▐▛███▜▌`
 * (`/^▐▛[█]+▜▌/`), which fails for indented art surrounded by
 * `│` frame chars + padding spaces. Result: no `agent_banner`
 * chunk emitted, dashboard never showed the branded card on a
 * fresh codespace deploy.
 *
 * The exact lines below came from running `claude` in
 * `/workspaces/join-the-queue` inside a GitHub codespace, captured
 * via the user's terminal screenshot.
 */
describe('detectStartupBanner — Claude v2.1.x box-drawn welcome', () => {
  it('detects the legacy 3-line art when wrapped in a two-column │ frame', () => {
    const lines = [
      '╭──────────────────────────────────────────────────┬──────────────────────────────╮',
      '│                                                    │ Tips for getting started        │',
      '│                 Welcome back Edgar!                │ Run /init to create a CLAUDE.md │',
      '│                       ▐▛███▜▌                      │ What\'s new                      │',
      '│                      ▝▜█████▛▘                     │ /code-review --fix              │',
      '│                        ▘▘ ▝▝                       │ Skills and slash commands       │',
      '│                                                    │                                  │',
      '│  Opus 4.7 (1M context) · Claude Team · Privacyhawk │                                  │',
      '│             /workspaces/join-the-queue             │                                  │',
      '╰──────────────────────────────────────────────────┴──────────────────────────────╯',
    ];
    const result = detectStartupBanner(lines);
    expect(result).not.toBeNull();
  });
});
