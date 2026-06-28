import type { BeadsConfigureAction } from '@codeagent/shared';
import { BdAdapter } from './bd-adapter';
import { ensureDoltResolvable } from './install-dolt';
import { deriveProjectIdentity } from './project-key';
import { prefixForProjectKey } from './project-prefix';

/**
 * A lightweight, read-only status probe — no install, no server start, no
 * provisioning. Used by the `status` action of `beads_configure` so a
 * cold/un-provisioned box never hangs the SSE while checking state.
 *
 * Shape matches the `probe` dep signature on `ConfigureBeadsDeps` so the
 * handler can wire it directly.
 */
export interface BeadsStatusProbe {
  bdAvailable: boolean;
  doltAvailable: boolean;
  serverUp: boolean;
  prefix: string | null;
}

/**
 * Seams so tests can stub the three read-only checks without touching the real
 * filesystem, PATH, or spawning `bd ping`.
 */
export const _probeSeam = {
  resolveBd: (cwd: string): boolean => new BdAdapter({ cwd }).isAvailable(),
  doltOnPath: (): boolean => ensureDoltResolvable(),
  ping: async (cwd: string): Promise<boolean> => {
    const adapter = new BdAdapter({ cwd });
    if (!adapter.isAvailable()) return false;
    const r = await adapter.run(['ping']);
    return r.code === 0;
  },
  derivePrefix: (cwd: string): string | null => {
    try {
      const { projectKey } = deriveProjectIdentity(cwd);
      return prefixForProjectKey(projectKey);
    } catch {
      return null;
    }
  },
};

/**
 * Read-only status probe: checks bd availability, dolt on PATH, server
 * reachability (via `bd ping`), and the project prefix — all without
 * installing, starting, or mutating anything.
 */
export async function probeBeadsStatus(cwd: string = process.cwd()): Promise<BeadsStatusProbe> {
  const bdAvailable = _probeSeam.resolveBd(cwd);
  const doltAvailable = _probeSeam.doltOnPath();
  const serverUp = bdAvailable && doltAvailable ? await _probeSeam.ping(cwd) : false;
  const prefix = _probeSeam.derivePrefix(cwd);
  return { bdAvailable, doltAvailable, serverUp, prefix };
}

export type BeadsConfigureResult = {
  enabled: boolean;
  running?: boolean;
  bdAvailable?: boolean;
  doltAvailable?: boolean;
  serverUp?: boolean;
  prefix?: string | null;
};

export interface ConfigureBeadsCtx { agent: string; cwd: string; pluginAuthToken?: string }

export interface ConfigureBeadsDeps {
  provision: () => Promise<{ bdAvailable: boolean; doltAvailable: boolean; serverUp: boolean; prefix: string | null }>;
  startWatcher: () => Promise<void>;
  stopWatcher: () => Promise<void>;
  probe: () => Promise<{ bdAvailable: boolean; doltAvailable: boolean; serverUp: boolean; prefix: string | null }>;
  revertAgentHook: (agent: string) => Promise<void>;
  persist: (cfg: { enabled: boolean }) => void;
  /** Returns the persisted enabled flag. Used by `status` to short-circuit
   *  when the user has explicitly disabled Beads — the dolt server stays up
   *  after disable (soft-disable) so a raw probe would falsely report enabled. */
  readEnabled: () => boolean;
  emit: (event: {
    type: 'beads_status';
    state: 'enabled' | 'disabled' | 'error' | 'provisioning';
    running?: boolean; bdAvailable?: boolean; doltAvailable?: boolean; serverUp?: boolean; error?: string;
  }) => void;
}

export async function configureBeads(
  action: BeadsConfigureAction,
  ctx: ConfigureBeadsCtx,
  deps: ConfigureBeadsDeps,
): Promise<BeadsConfigureResult> {
  if (action === 'status') {
    // Honor the persisted disable flag FIRST. The dolt server stays running
    // after a soft-disable (no process kill), so probing would falsely report
    // enabled and even re-provision. Short-circuit to disabled without calling
    // probe() when the user has explicitly disabled Beads.
    if (deps.readEnabled() === false) {
      deps.emit({ type: 'beads_status', state: 'disabled', running: false });
      return { enabled: false, running: false };
    }
    const p = await deps.probe();
    const running = p.serverUp && p.bdAvailable;
    deps.emit({ type: 'beads_status', state: running ? 'enabled' : 'disabled', running, ...p });
    return { enabled: running, running, ...p };
  }

  if (action === 'disable') {
    deps.persist({ enabled: false });
    await deps.stopWatcher().catch(() => undefined);
    await deps.revertAgentHook(ctx.agent).catch(() => undefined);
    deps.emit({ type: 'beads_status', state: 'disabled' });
    return { enabled: false };
  }

  // enable
  deps.persist({ enabled: true });
  deps.emit({ type: 'beads_status', state: 'provisioning' });
  const p = await deps.provision();
  if (!p.serverUp || !p.bdAvailable) {
    deps.emit({ type: 'beads_status', state: 'error', error: 'Beads provisioning failed', ...p });
    return { enabled: false, ...p };
  }
  await deps.startWatcher().catch(() => undefined);
  const running = true;
  deps.emit({ type: 'beads_status', state: 'enabled', running, ...p });
  return { enabled: true, running, ...p };
}
