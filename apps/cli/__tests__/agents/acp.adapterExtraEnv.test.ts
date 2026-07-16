import { describe, it, expect } from 'vitest';
import { computeAdapterExtraEnv } from '../../src/agents/acp/runner';

/**
 * The codex-acp adapter starts in its default `agent` (workspace-write) mode,
 * whose sandbox BLOCKS network — including the loopback socket to the shared
 * Beads/Dolt server on 127.0.0.1:3308 — so `bd create` fails on a codespace /
 * self-hosted box. In that autonomous plane (autoApprovePermissions) we start
 * Codex in `agent-full-access` via INITIAL_AGENT_MODE so infra can reach
 * localhost. Everywhere else the safe default is preserved.
 */
describe('computeAdapterExtraEnv', () => {
  it('sets INITIAL_AGENT_MODE=agent-full-access for Codex in the autonomous plane', () => {
    const env = computeAdapterExtraEnv({
      agent: 'codex',
      autoApprovePermissions: true,
      disable1mContext: false,
    });
    expect(env.INITIAL_AGENT_MODE).toBe('agent-full-access');
  });

  it('does NOT set INITIAL_AGENT_MODE for Codex when running interactively (no auto-approve)', () => {
    const env = computeAdapterExtraEnv({
      agent: 'codex',
      autoApprovePermissions: false,
      disable1mContext: false,
    });
    expect(env.INITIAL_AGENT_MODE).toBeUndefined();
  });

  it('never sets INITIAL_AGENT_MODE for non-Codex agents, even in the autonomous plane', () => {
    const env = computeAdapterExtraEnv({
      agent: 'claude',
      autoApprovePermissions: true,
      disable1mContext: false,
    });
    expect(env.INITIAL_AGENT_MODE).toBeUndefined();
  });

  // claude ALWAYS freezes the self-updating binary (DISABLE_AUTOUPDATER) so it
  // can't drift past the pinned ACP adapter and leak TUI chrome into the stream.
  const CLAUDE_FREEZE = {
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };

  it('carries the 1M-context opt-out independently, and both knobs can coexist for Codex', () => {
    expect(
      computeAdapterExtraEnv({ agent: 'claude', autoApprovePermissions: false, disable1mContext: true }),
    ).toEqual({ CLAUDE_CODE_DISABLE_1M_CONTEXT: '1', ...CLAUDE_FREEZE });

    expect(
      computeAdapterExtraEnv({ agent: 'codex', autoApprovePermissions: true, disable1mContext: true }),
    ).toEqual({ CLAUDE_CODE_DISABLE_1M_CONTEXT: '1', INITIAL_AGENT_MODE: 'agent-full-access' });
  });

  it('claude freezes the auto-updater even in the plain interactive default', () => {
    expect(
      computeAdapterExtraEnv({ agent: 'claude', autoApprovePermissions: false, disable1mContext: false }),
    ).toEqual({ ...CLAUDE_FREEZE });
  });
});
