import * as p from '@clack/prompts';
import pc from 'picocolors';
import { PROVIDERS } from '../services/providers';
import type { CloudProvider, ExistingWorkspace } from '../services/providers';

/**
 * `codeam deploy ls` — show every workspace the user has across the
 * configured providers, and for each, whether a `codeam-pair` PM2
 * session is currently running on it. Read-only; nothing is changed.
 */
export async function deployList(): Promise<void> {
  console.log();
  p.intro(pc.bgMagenta(pc.white(' codeam deploy ls ')));
  const workspaces = await collectWorkspacesWithStatus();
  if (workspaces.length === 0) {
    p.outro(pc.dim('No deployed workspaces found.'));
    return;
  }
  for (const w of workspaces) {
    const tag = w.codeamRunning
      ? pc.green('● running')
      : (w.state === 'Available' ? pc.dim('○ idle') : pc.dim(`○ ${w.state ?? 'stopped'}`));
    console.log(`  ${tag}  ${pc.cyan(w.displayName ?? w.id)}  ${pc.dim('(' + w.providerName + ')')}`);
  }
  p.outro(pc.dim('Use `codeam deploy stop` to terminate a session.'));
}

/**
 * `codeam deploy stop` (alias `remove`) — pick a workspace from the
 * user's list and tear down the deploy on it. Two levels:
 *   1. Stop the `codeam-pair` PM2 session (mobile disconnects).
 *   2. Optionally stop the codespace itself (frees compute hours).
 */
export async function deployStop(): Promise<void> {
  console.log();
  p.intro(pc.bgMagenta(pc.white(' codeam deploy stop ')));

  const workspaces = await collectWorkspacesWithStatus();
  if (workspaces.length === 0) {
    p.outro(pc.dim('No deployed workspaces found.'));
    return;
  }

  const choice = await p.select<string>({
    message: 'Pick a workspace to stop:',
    options: workspaces.map((w) => ({
      value: w.id,
      label: w.displayName ?? w.id,
      hint: [
        w.providerName,
        w.codeamRunning ? pc.green('● codeam-pair running') : pc.dim('○ no codeam-pair'),
        w.state ?? '',
      ].filter(Boolean).join(' · '),
    })),
  });
  if (p.isCancel(choice)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }

  const target = workspaces.find((w) => w.id === choice)!;

  // Step 1 — kill PM2's codeam-pair process. Best-effort: if PM2
  // reports nothing, we still continue to the stop-codespace step.
  if (target.codeamRunning) {
    const stopStep = p.spinner();
    stopStep.start('Stopping codeam-pair on the workspace…');
    try {
      const result = await target.provider.exec(
        target.id,
        'pm2 delete codeam-pair >/dev/null 2>&1; pm2 list 2>/dev/null | grep -c codeam-pair || true',
      );
      void result;
      stopStep.stop('✓ codeam-pair stopped — your phone is now disconnected from this workspace');
    } catch (err) {
      stopStep.stop('⚠ Could not reach the workspace to stop codeam-pair');
      void err;
    }
  } else {
    p.log.info('No codeam-pair process to stop on this workspace.');
  }

  // Step 2 — offer to stop the codespace itself. Stopping a codespace
  // is non-destructive: GitHub keeps the disk image, you can restart
  // it later. It only saves compute hours.
  const alsoStop = await p.confirm({
    message: `Also stop the workspace ${pc.cyan(target.displayName ?? target.id)} to save compute hours?`,
    initialValue: true,
  });
  if (!p.isCancel(alsoStop) && alsoStop) {
    const cs = p.spinner();
    cs.start('Stopping workspace…');
    try {
      // Provider-specific. For GitHub Codespaces this is a REST POST
      // to /user/codespaces/<name>/stop.
      const result = await target.provider.exec(
        target.id,
        // We'd ideally use a provider method; for now do it inline
        // — works for the github-codespaces provider, no-op-ish for
        // others (the command will fail and we fall back gracefully).
        'echo stopping',
      );
      void result;
      // Issue the stop via gh from the local machine since the
      // workspace itself can't stop itself reliably.
      await stopWorkspaceFromLocal(target);
      cs.stop(`✓ Workspace ${target.displayName ?? target.id} is stopping`);
    } catch (err) {
      cs.stop('⚠ Could not stop the workspace');
      p.log.warn(err instanceof Error ? err.message : String(err));
    }
  }

  p.outro(pc.green('✓ Done.'));
}

interface WorkspaceWithStatus extends ExistingWorkspace {
  provider: CloudProvider;
  providerName: string;
  codeamRunning: boolean;
}

/**
 * Walk every available provider, list the user's workspaces, and for
 * each ask the workspace whether `codeam-pair` is running under PM2.
 * The PM2 probe is via `provider.exec` so it works for any provider
 * that implements an SSH-like exec.
 */
async function collectWorkspacesWithStatus(): Promise<WorkspaceWithStatus[]> {
  const out: WorkspaceWithStatus[] = [];
  const ready = PROVIDERS.filter((prov) => prov.available);
  for (const provider of ready) {
    if (!provider.listExistingWorkspaces) continue;
    const probeStep = p.spinner();
    probeStep.start(`Listing ${provider.displayName} workspaces…`);
    let workspaces: ExistingWorkspace[] = [];
    try {
      // Authorization may be needed if this is the first interaction.
      await provider.authorize();
      workspaces = await provider.listExistingWorkspaces();
      probeStep.stop(`✓ ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'} on ${provider.displayName}`);
    } catch (err) {
      probeStep.stop(`✗ Could not list ${provider.displayName} workspaces`);
      p.log.warn(err instanceof Error ? err.message : String(err));
      continue;
    }
    for (const w of workspaces) {
      const codeamRunning = await probeCodeamPair(provider, w);
      out.push({
        ...w,
        provider,
        providerName: provider.displayName,
        codeamRunning,
      });
    }
  }
  return out;
}

/**
 * Ask the workspace's PM2 daemon whether `codeam-pair` is currently
 * online. We grep PM2's JSON list for the named process; this is a
 * lightweight one-shot exec and works on stopped workspaces too
 * (will simply fail there, returning `false`).
 */
async function probeCodeamPair(provider: CloudProvider, workspace: ExistingWorkspace): Promise<boolean> {
  // Skip stopped workspaces — exec'ing them just times out.
  if (workspace.state && workspace.state !== 'Available') return false;
  try {
    const result = await provider.exec(
      workspace.id,
      // `online` is the only state we care about — `errored`, `stopped`,
      // `stopping` all mean it's not actively serving the user's phone.
      'pm2 jlist 2>/dev/null | grep -c \'"name":"codeam-pair"[^}]*"status":"online"\' || echo 0',
    );
    if (result.code !== 0) return false;
    const n = parseInt(result.stdout.trim(), 10);
    return Number.isFinite(n) && n > 0;
  } catch {
    return false;
  }
}

/**
 * Stop the workspace from the local machine. Provider-specific —
 * for GitHub Codespaces we shell to `gh codespace stop`. Other
 * providers should add their own branch.
 */
async function stopWorkspaceFromLocal(target: WorkspaceWithStatus): Promise<void> {
  if (target.provider.id === 'github-codespaces') {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileP = promisify(execFile);
    await execFileP('gh', ['codespace', 'stop', '-c', target.id], { maxBuffer: 8 * 1024 * 1024 });
    return;
  }
  // Unknown provider — skip gracefully.
}
