import type { AgentId, BeadsActionPayload } from '@codeagent/shared';
import { BdAdapter } from './bd-adapter';
import { provisionBeads } from './provisioner';
import { BeadsWatcher } from './watcher';
import { applyBeadsAction } from './apply-actions';
import { log } from '../services/logger';

export { BdAdapter, createBdAdapter, defaultBeadsHomeDir } from './bd-adapter';
export type { BdRunResult, BdAdapterOptions } from './bd-adapter';
export { provisionBeads, _provisionSeam } from './provisioner';
export type { ProvisionResult, ProvisionOptions } from './provisioner';
export { BeadsWatcher } from './watcher';
export type { BeadsWatcherOptions } from './watcher';
export { applyBeadsAction, buildBdArgs } from './apply-actions';
export type { ApplyActionResult } from './apply-actions';
export { installBd, resolveInstallStrategy } from './install-bd';
export { deriveProjectIdentity, normalizeOrigin } from './project-key';
export type { ProjectIdentity } from './project-key';

/**
 * Composition-root Beads orchestrator (SRP decision D10). Ties the home-brain
 * provisioner + the issues.jsonl watcher together so the call-site wiring is a
 * one-liner. Invoked from the CLI's shared start path (`start()` AND
 * `startInfraOnly()`) — NOT from the agent runner. The agent runners carry
 * zero beads code.
 *
 * Returns the live `BeadsWatcher` + adapter (or null) so the composition root
 * can `stop()` the watcher on teardown and route incoming `beads_action`
 * commands into `handleBeadsActionCommand`. The non-fatal + kill-switch
 * semantics live in `wiring.ts`, which is what `start()` / `startInfraOnly()`
 * call; this function assumes it should run.
 */
export interface StartBeadsOptions {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  cwd?: string;
  /** Session agents to wire natively via `bd setup <recipe> --global` (D12). */
  agents?: AgentId[];
}

export interface StartedBeads {
  watcher: BeadsWatcher;
  adapter: BdAdapter;
}

export async function startBeads(opts: StartBeadsOptions): Promise<StartedBeads | null> {
  const adapter = new BdAdapter({ cwd: opts.cwd });

  // Provision the home brain (ensure-bd + install fallback + idempotent init +
  // export.auto). When bd can't be made available, provisioning reports
  // bdAvailable:false and we run without a watcher this session.
  const provision = await provisionBeads({ cwd: opts.cwd, adapter, agents: opts.agents });
  // Need bd + an initialized workspace + a LIVE shared dolt sql-server: the
  // watcher's `bd ready`/`bd list` hit the server, so without it they'd just
  // error. Any missing piece → run without a watcher this session (non-fatal).
  if (!provision.bdAvailable || !provision.initialized || !provision.serverUp) {
    log.warn('beads', 'beads not fully provisioned — watcher not started this run');
    return null;
  }

  const watcher = new BeadsWatcher({
    sessionId: opts.sessionId,
    pluginId: opts.pluginId,
    pluginAuthToken: opts.pluginAuthToken,
    cwd: opts.cwd,
    adapter,
  });
  watcher.start();
  // Push the current state immediately so the phone has a snapshot (even an
  // empty one) without waiting for the next bd mutation.
  void watcher.syncNow();

  return { watcher, adapter };
}

/**
 * Route a relayed `beads_action` command into the native bd apply path, then
 * trigger a push via the live watcher. The live `StartedBeads` handle comes
 * from the composition-root-owned provisioner, threaded through the relay.
 */
export async function handleBeadsActionCommand(
  action: BeadsActionPayload,
  started: StartedBeads,
): Promise<void> {
  await applyBeadsAction(action, {
    adapter: started.adapter,
    onApplied: () => started.watcher.syncNow(),
  });
}
