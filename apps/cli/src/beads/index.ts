import type { AgentId, BeadsActionPayload } from '@codeagent/shared';
import { BdAdapter } from './bd-adapter';
import { bootstrapBeads } from './bootstrap';
import { BeadsWatcher } from './watcher';
import { applyBeadsAction } from './apply-actions';
import { installBd } from './install-bd';
import { log } from '../services/logger';

export { BdAdapter, createBdAdapter, defaultBeadsHomeDir } from './bd-adapter';
export type { BdRunResult, BdAdapterOptions } from './bd-adapter';
export { bootstrapBeads } from './bootstrap';
export type { BootstrapResult, BootstrapOptions } from './bootstrap';
export { BeadsWatcher } from './watcher';
export type { BeadsWatcherOptions } from './watcher';
export { applyBeadsAction, buildBdArgs } from './apply-actions';
export type { ApplyActionResult } from './apply-actions';
export { installBd, resolveInstallStrategy } from './install-bd';
export { deriveProjectIdentity, normalizeOrigin } from './project-key';
export type { ProjectIdentity } from './project-key';

/**
 * Gated orchestrator — the single entry point the pair / codespace bootstrap
 * path calls. It is intentionally the ONLY place that ties bootstrap + watcher
 * together so the call-site wiring is a one-liner and the `beads` feature flag
 * (server-pushed, default OFF) is checked exactly once, up front.
 *
 * The flag value is INJECTED (`enabled`) rather than fetched here so this stays
 * decoupled from the backend gates endpoint shape — the caller passes whatever
 * the heartbeat / gates response reports. When the flag is off, this is a
 * complete no-op: no bd resolution, no daemon, no watcher.
 *
 * Returns the live `BeadsWatcher` (or null) so the caller can `stop()` it on
 * session teardown and route incoming `beads_action` commands into
 * `handleBeadsActionCommand`.
 */
export interface StartBeadsOptions {
  /** Server-pushed `beads` feature flag for this user. */
  enabled: boolean;
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  /** Agents detected for this session — each gets `bd setup <recipe>`. */
  agents: AgentId[];
  cwd?: string;
  /** Consent to run the OS installer when the bundled binary is missing. */
  allowInstall?: boolean;
}

export interface StartedBeads {
  watcher: BeadsWatcher;
  adapter: BdAdapter;
}

export async function maybeStartBeads(
  opts: StartBeadsOptions,
): Promise<StartedBeads | null> {
  if (!opts.enabled) {
    log.trace('beads', 'beads flag off — skipping');
    return null;
  }

  const adapter = new BdAdapter({ cwd: opts.cwd });

  // Resolve bd; offer the consented OS installer as a last resort.
  if (!adapter.isAvailable() && opts.allowInstall) {
    log.info('beads', 'bd not found — running OS installer');
    await installBd();
  }
  if (!adapter.isAvailable()) {
    log.warn('beads', 'bd unavailable — beads disabled for this session');
    return null;
  }

  const boot = await bootstrapBeads({ cwd: opts.cwd, agents: opts.agents, adapter });
  if (!boot.serverUp) {
    log.warn('beads', 'beads server not up — watcher not started this run');
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
  // Push the current state immediately so the phone has a snapshot without
  // waiting for the next bd mutation.
  void watcher.syncNow();

  return { watcher, adapter };
}

/**
 * Route a relayed `beads_action` command into the native bd apply path, then
 * trigger a push via the live watcher. Returns the apply result so the relay
 * can ack the command.
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
