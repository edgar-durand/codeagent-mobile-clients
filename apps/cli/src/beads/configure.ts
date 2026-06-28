import type { BeadsConfigureAction } from '@codeagent/shared';

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
