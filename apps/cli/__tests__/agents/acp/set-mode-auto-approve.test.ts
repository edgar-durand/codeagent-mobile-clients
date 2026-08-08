/**
 * Root-cause regression (Rafael, 2026-08-08): on a MANAGED session (codespace /
 * self-hosted) `autoApprovePermissions` is set true at spawn (CODESPACES /
 * CODEAM_AUTO_APPROVE) so headless turns never stall. But the mobile mode toggle
 * (`set_mode`) only switched the agent's NATIVE mode and never touched that flag,
 * so switching to a manual "ask" mode was a NO-OP — onRequestPermission kept
 * auto-approving every tool ("en manual no pregunta yes/no, deniega solo").
 * setModeH now sets `opts.autoApprovePermissions = modeIsFullAutoApprove(modeId)`
 * so only a full-bypass mode stays auto; every ask-mode flips it false so the
 * agent's permission prompts RELAY to mobile. This locks the classifier (the
 * decision the fix hinges on) — mutation-resistant on both directions.
 */
import { describe, it, expect } from 'vitest';
import { modeIsFullAutoApprove } from '../../../src/agents/acp/command-handlers';

describe('modeIsFullAutoApprove — only full-bypass modes keep CLI auto-approve', () => {
  it('is TRUE for bypass/yolo/danger/full-access/skip/auto aliases (agent skips all prompts)', () => {
    for (const m of [
      'bypassPermissions', // Claude
      'bypass',
      'yolo',
      'dangerouslySkip',
      'danger-full-access',
      'skip-permissions',
      'auto-approve',
    ]) {
      expect(modeIsFullAutoApprove(m)).toBe(true);
    }
  });

  it('is FALSE for every ask-mode → the CLI must RELAY the agent prompt to mobile', () => {
    for (const m of ['default', 'plan', 'acceptEdits', 'ask', 'normal', 'edit']) {
      expect(modeIsFullAutoApprove(m)).toBe(false);
    }
  });
});
