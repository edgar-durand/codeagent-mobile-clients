// src/services/headroom/configure.ts
import {
  agentIdToHeadroomKind,
  isHeadroomSupportedAgent,
  type HeadroomStep,
} from '../../commands/host-agent';
import type { HeadroomStatus } from '@codeagent/shared';
import type { Savings } from './stats-reporter';

export interface ConfigureCtx {
  agent: string;
  pluginAuthToken?: string;
  savingsIngestUrl?: string;
}

export interface ConfigureDeps {
  /** Run headroom setup; mirrors `setupHeadroomForSelfHosted` signature. */
  setup: (
    agent: string,
    runner?: undefined,
    opts?: { extras?: string[]; onProgress?: (step: HeadroomStep) => void },
  ) => Promise<boolean>;
  /** GET :8787/stats → Savings snapshot, or null when proxy not running. */
  probeStats: () => Promise<Savings | null>;
  persist: (config: { enabled: boolean; agent?: string; ingestUrl?: string }) => void;
  readEnabled: () => boolean;
  startReporter: (opts: { agent: string; ingestUrl?: string; pluginAuthToken?: string }) => void;
  stopReporter: () => void;
  restoreAgentHeadroomConfig: (kind: string) => boolean;
  stopProxy: () => void;
  emit: (event: HeadroomEvent) => void;
}

type HeadroomEvent =
  | { type: 'headroom_progress'; step: HeadroomStep }
  | { type: 'headroom_status'; state: HeadroomStatus['state'] };

export type HeadroomResult =
  | { enabled: boolean; running?: boolean; savings?: Savings }
  | { supported: false };

export async function configureHeadroom(
  action: 'enable' | 'disable' | 'status',
  ctx: ConfigureCtx,
  deps: ConfigureDeps,
): Promise<HeadroomResult> {
  const kind = agentIdToHeadroomKind(ctx.agent);

  if (action === 'status') {
    const stats = await deps.probeStats();
    return { enabled: deps.readEnabled(), running: stats !== null, savings: stats ?? undefined };
  }

  if (action === 'enable') {
    if (!isHeadroomSupportedAgent(ctx.agent)) return { supported: false };
    const ok = await deps.setup(ctx.agent, undefined, {
      extras: ['proxy', 'code', 'image'],
      onProgress: (step) => deps.emit({ type: 'headroom_progress', step }),
    });
    if (!ok) {
      deps.emit({ type: 'headroom_status', state: 'error' });
      return { enabled: false };
    }
    deps.persist({ enabled: true, agent: kind, ingestUrl: ctx.savingsIngestUrl });
    // Only start the savings/stats reporter when we have a plugin-auth token:
    // every POST to the savings ingest is PluginAuthGuard-gated and 401s
    // without it, so an unauthenticated reporter would just poll :8787 and fire
    // rejected requests forever. Headroom (the proxy) still runs and compresses
    // locally; only the backend savings reporting is skipped.
    if (ctx.pluginAuthToken) {
      deps.startReporter({
        agent: kind,
        ingestUrl: ctx.savingsIngestUrl,
        pluginAuthToken: ctx.pluginAuthToken,
      });
    }
    deps.emit({ type: 'headroom_status', state: 'enabled' });
    return { enabled: true };
  }

  // disable — restore FIRST (order matters: agent config must be restored before
  // the proxy is stopped so any in-flight requests can drain cleanly).
  deps.restoreAgentHeadroomConfig(kind);
  deps.stopProxy();
  deps.persist({ enabled: false });
  deps.stopReporter();
  deps.emit({ type: 'headroom_status', state: 'disabled' });
  return { enabled: false };
}
