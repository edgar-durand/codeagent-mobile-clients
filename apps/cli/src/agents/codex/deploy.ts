import type { AgentId } from '@codeagent/shared';
import type { CloudProvider } from '../../services/providers/types';
import type { DeployStrategy, LocalCredentialSource } from '../strategy';
import {
  detectLocalCodexCredentials,
  bridgeLocalCodexCredentials,
  runRemoteCodexLogin,
  verifyCodexAuth,
} from './credentials';

export class CodexDeployStrategy implements DeployStrategy {
  readonly id: AgentId = 'codex';

  async detectLocalCredentials(): Promise<LocalCredentialSource> {
    return detectLocalCodexCredentials();
  }

  async bridgeLocalCredentials(provider: CloudProvider, workspaceId: string): Promise<LocalCredentialSource> {
    return bridgeLocalCodexCredentials(provider, workspaceId);
  }

  async runRemoteLogin(provider: CloudProvider, workspaceId: string): Promise<void> {
    return runRemoteCodexLogin(provider, workspaceId);
  }

  /**
   * Steps 5–7 of the existing local-deploy flow, adapted for Codex:
   *   1. Install codex via npm
   *   2. (skipped — bridge already happened before this method runs, or the
   *      fallback runs via runRemoteLogin)
   *   3. Verify auth; fallback to remote login if verify fails AND no
   *      credentials were bridged.
   */
  async setupOnWorkspace(
    provider: CloudProvider,
    workspaceId: string,
    opts: { bridged: LocalCredentialSource['source'] },
  ): Promise<void> {
    const installResult = await provider.exec(workspaceId, 'npm install -g @openai/codex');
    if (installResult.code !== 0) {
      throw new Error(`codex install failed: ${installResult.stderr.slice(0, 500)}`);
    }

    const verified = await verifyCodexAuth(provider, workspaceId);
    if (!verified && opts.bridged === 'none') {
      await runRemoteCodexLogin(provider, workspaceId);
    }
  }
}
