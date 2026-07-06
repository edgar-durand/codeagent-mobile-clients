import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as p from '@clack/prompts';
import type { AgentId } from '@codeam/shared';
import type { CloudProvider } from '../../services/providers/types';
import type { DeployStrategy, LocalCredentialSource } from '../strategy';
import {
  detectLocalClaudeCredentials,
  bridgeClaudeCredentials,
  runRemoteClaudeLogin,
  verifyClaudeAuth,
} from './credentials';

export class ClaudeDeployStrategy implements DeployStrategy {
  readonly id: AgentId = 'claude';

  async detectLocalCredentials(): Promise<LocalCredentialSource> {
    return detectLocalClaudeCredentials();
  }

  async bridgeLocalCredentials(
    provider: CloudProvider,
    workspaceId: string,
  ): Promise<LocalCredentialSource> {
    return bridgeClaudeCredentials(provider, workspaceId);
  }

  async runRemoteLogin(provider: CloudProvider, workspaceId: string): Promise<void> {
    return runRemoteClaudeLogin(provider, workspaceId);
  }

  /**
   * Steps 5-9 of the deploy flow:
   *  - Install Claude CLI on the workspace
   *  - Copy local ~/.claude config dir (excluding heavy state)
   *  - Ship ~/.claude.json (only when creds were bridged — privacy)
   *  - Verify auth, fallback to runRemoteLogin
   */
  async setupOnWorkspace(
    provider: CloudProvider,
    workspaceId: string,
    opts: { bridged: LocalCredentialSource['source'] },
  ): Promise<void> {
    // STEP 5 — Install Claude CLI on the workspace.
    const claudeStep = p.spinner();
    claudeStep.start('Installing Claude CLI on workspace…');
    const installResult = await provider.exec(
      workspaceId,
      'curl -fsSL https://claude.ai/install.sh | bash',
    );
    if (installResult.code !== 0) {
      claudeStep.stop('✗ Claude CLI install failed');
      p.cancel(installResult.stderr.slice(0, 1000));
      process.exit(1);
    }
    claudeStep.stop('✓ Claude CLI installed');

    // STEP 6 — Copy local config (skills/settings/subagents/plugins).
    // This goes AFTER install so it overlays the user's customisations
    // on top of install's defaults. Excludes drop the heavy local-only
    // state (~700MB of conversation history etc.) that the remote
    // never reads.
    const localClaudeDir = path.join(os.homedir(), '.claude');
    const haveLocalClaude =
      fs.existsSync(localClaudeDir) && fs.statSync(localClaudeDir).isDirectory();
    if (haveLocalClaude) {
      const copyStep = p.spinner();
      copyStep.start('Copying local Claude config to workspace…');
      try {
        await provider.uploadDirectory(
          workspaceId,
          localClaudeDir,
          '/home/codespace/.claude',
          {
            exclude: [
              './projects',          // per-project conversation history (often 700MB+)
              './file-history',      // per-project file diffs
              './downloads',         // downloaded artifacts
              './image-cache',       // cached images
              './paste-cache',       // clipboard/paste cache
              './backups',           // local backups
              './shell-snapshots',   // shell history snapshots
              './telemetry',         // analytics dumps
              './statsig',           // feature-flag cache
              './cache',             // generic cache dir
              './history.jsonl',     // global REPL history
              './ide',               // local IDE bridge state
              './todos',             // local todo state
              './tasks',             // local task state
              // Don't overwrite the credentials we already staged in
              // step 4 — the local dir on macOS doesn't have a flat
              // credentials file anyway, but on Linux it would, and a
              // re-write here would be redundant.
              './.credentials.json',
            ],
          },
        );
        copyStep.stop('✓ Claude config uploaded');
      } catch (err) {
        copyStep.stop('⚠ Could not upload Claude config (continuing)');
        void err;
      }
    }

    // STEP 6.5 — Ship `~/.claude.json` (the sibling FILE, not the dir
    // tarred above). This file holds the user's UI state across
    // launches: `hasCompletedOnboarding`, `hasIdeOnboardingBeenShown`,
    // `lastOnboardingVersion`, `tipsHistory`, etc. Without it, claude
    // treats the codespace as a brand-new install and shows the
    // "Select login method" + onboarding flow on every interactive
    // launch even when credentials are already valid.
    //
    // Only ships when the user opted into the credential bridge — the
    // file contains `oauthAccount` (email, orgId) so it'd be a privacy
    // leak to ship when they're going to log in as a different account.
    if (opts.bridged !== 'none') {
      const localClaudeJson = path.join(os.homedir(), '.claude.json');
      if (fs.existsSync(localClaudeJson)) {
        try {
          const contents = fs.readFileSync(localClaudeJson);
          await provider.uploadFile(
            workspaceId,
            '/home/codespace/.claude.json',
            contents,
            { mode: 0o600 },
          );
        } catch (err) {
          // Best-effort: claude still works without this file, the
          // user just sees the onboarding screen.
          void err;
        }
      }
    }

    // STEP 7 — Verify Claude auth on the workspace, and fall back to
    // interactive login if anything is wrong. We don't trust "we wrote
    // a file" as success — credentials might be expired, the format
    // might have changed in a Claude release, the keychain might've
    // been empty, etc. The user sees ONE outcome: a logged-in Claude.
    // They never have to know how it got there.
    const verifyStep = p.spinner();
    verifyStep.start('Verifying Claude auth on workspace…');
    const verified = await verifyClaudeAuth(provider, workspaceId);
    if (verified) {
      verifyStep.stop('✓ Claude is logged in — no re-auth needed');
    } else {
      verifyStep.stop('· Claude not yet authenticated — running login flow');
      await runRemoteClaudeLogin(provider, workspaceId);
      // After interactive login, verify one more time so we catch the
      // case where the user bailed out mid-flow.
      const reverified = await verifyClaudeAuth(provider, workspaceId);
      if (!reverified) {
        p.note(
          'Claude auth could not be confirmed. You may need to run `claude /login` manually inside the codespace.',
          'Heads up',
        );
      }
    }
  }
}
