import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { ACP_AGENT_HOOKS } from '../../../src/agents/acp/agent-hooks';

/**
 * ACP toolchain stability guard.
 *
 * The 2026-07-16 "broken chat" incident: Claude Code's SDK-bundled binary
 * self-updated to v2.1.211 and drifted PAST the ACP adapter the CLI was tested
 * against, so it began streaming its TUI chrome (What's-new banner, status line,
 * box-drawing) into the ACP text channel — which paints as a garbled chat on
 * mobile. The fix has three load-bearing parts; this contract fails CI the moment
 * any of them silently regress, so a new Claude Code / adapter version can only
 * reach users through a DELIBERATE, gated release (the Step 8 "verify a live
 * deploy" discipline), never by a floating range or a dropped env freeze.
 */
describe('ACP toolchain version freeze (stability guard)', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'),
  ) as { dependencies: Record<string, string> };

  // Every ACP-protocol / adapter dependency must be EXACT-pinned so a
  // `npm install` can never float the running version ahead of what was tested.
  const ACP_DEPS = [
    '@agentclientprotocol/sdk',
    '@agentclientprotocol/claude-agent-acp',
    '@agentclientprotocol/codex-acp',
  ];

  it.each(ACP_DEPS)('%s is exact-pinned (no ^ / ~ / range)', (dep) => {
    const spec = pkg.dependencies[dep];
    expect(spec, `${dep} must be a dependency`).toBeTruthy();
    // Exact semver only: "1.2.1", not "^1.2.1" / "~1.2" / "*" / ">=1".
    expect(spec, `${dep} must be exact-pinned (got "${spec}")`).toMatch(
      /^\d+\.\d+\.\d+$/,
    );
  });

  it('claude freezes the self-updating binary via DISABLE_AUTOUPDATER', () => {
    // Belt to the pin's suspenders: even pinned, the on-disk Claude Code binary
    // self-updates unless told not to. This env must stay on the claude spawn.
    const env = ACP_AGENT_HOOKS.claude?.startupExtraEnv?.({ autoApprovePermissions: false }) ?? {};
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
  });
});
