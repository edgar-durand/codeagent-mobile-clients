// src/services/headroom/configure.ts
import { agentIdToHeadroomKind, isHeadroomSupportedAgent } from '../../commands/host-agent';
import {
  USER_EVENTS,
  HEADROOM_EXTRAS_BY_SURFACE,
  type HeadroomStatus,
  type HeadroomStep,
} from '@codeam/shared';
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
  | { type: typeof USER_EVENTS.HEADROOM_PROGRESS; step: HeadroomStep }
  | { type: typeof USER_EVENTS.HEADROOM_STATUS; state: HeadroomStatus['state'] };

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
      // On-demand surface ships the extra `image` compression support — see
      // the shared Headroom manifest (`HEADROOM_EXTRAS_BY_SURFACE`).
      extras: [...HEADROOM_EXTRAS_BY_SURFACE.onDemand],
      onProgress: (step) => deps.emit({ type: USER_EVENTS.HEADROOM_PROGRESS, step }),
    });
    if (!ok) {
      deps.emit({ type: USER_EVENTS.HEADROOM_STATUS, state: 'error' });
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
    deps.emit({ type: USER_EVENTS.HEADROOM_STATUS, state: 'enabled' });
    return { enabled: true };
  }

  // disable — restore FIRST (order matters: agent config must be restored before
  // the proxy is stopped so any in-flight requests can drain cleanly).
  deps.restoreAgentHeadroomConfig(kind);
  deps.stopProxy();
  deps.persist({ enabled: false });
  deps.stopReporter();
  deps.emit({ type: USER_EVENTS.HEADROOM_STATUS, state: 'disabled' });
  return { enabled: false };
}
