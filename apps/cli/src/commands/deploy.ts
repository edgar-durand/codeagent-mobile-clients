import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { PROVIDERS } from '../services/providers';
import type { CloudProvider, DeployableProject, Workspace } from '../services/providers';

/**
 * `codeam deploy` — provision a fresh cloud workspace, install the
 * Claude CLI inside it, copy the user's local Claude config so they
 * don't have to re-auth, and finish by streaming `codeam pair` from
 * the workspace so the user gets a live pairing code on their local
 * terminal that's already connected to the remote codespace.
 *
 * The orchestrator is provider-agnostic — it only talks through the
 * `CloudProvider` interface — so adding new backends (Gitpod, Coder,
 * etc.) is one new file in `services/providers/`.
 */
export async function deploy(): Promise<void> {
  console.log();
  p.intro(pc.bgMagenta(pc.white(' codeam deploy ')));

  const provider = await pickProvider();
  if (!provider) {
    p.cancel('No provider selected.');
    process.exit(0);
  }

  // Step 1 — Authorize.
  const authStep = p.spinner();
  authStep.start(`Authorizing with ${provider.displayName}…`);
  try {
    await provider.authorize();
    authStep.stop(`✓ Authorized with ${provider.displayName}`);
  } catch (err) {
    authStep.stop(`✗ Authorization failed`);
    p.cancel(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Step 2 — List + pick project.
  const listStep = p.spinner();
  listStep.start('Loading your projects…');
  let projects: DeployableProject[] = [];
  try {
    projects = await provider.listProjects();
    listStep.stop(`✓ ${projects.length} project${projects.length === 1 ? '' : 's'} available`);
  } catch (err) {
    listStep.stop(`✗ Could not list projects`);
    p.cancel(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (projects.length === 0) {
    p.cancel('No projects found on the account.');
    process.exit(0);
  }

  const projectId = await p.select<string>({
    message: 'Select a project to deploy:',
    options: projects.slice(0, 50).map((proj) => ({
      value: proj.id,
      label: proj.fullName,
      hint: proj.description ? proj.description.slice(0, 80) : (proj.private ? 'private' : 'public'),
    })),
  });
  if (p.isCancel(projectId) || typeof projectId !== 'string') {
    p.cancel('Cancelled.');
    process.exit(0);
  }
  const project = projects.find((proj) => proj.id === projectId)!;

  // Step 3 — Create workspace.
  const createStep = p.spinner();
  createStep.start(`Creating workspace for ${project.fullName}…`);
  let workspace: Workspace;
  try {
    workspace = await provider.createWorkspace(project.id);
    createStep.stop(`✓ Workspace ready: ${workspace.displayName ?? workspace.id}`);
  } catch (err) {
    createStep.stop(`✗ Workspace creation failed`);
    p.cancel(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Step 4 — Install Claude CLI on the workspace.
  const claudeStep = p.spinner();
  claudeStep.start('Installing Claude CLI on workspace…');
  const installResult = await provider.exec(
    workspace.id,
    'curl -fsSL https://claude.ai/install.sh | bash',
  );
  if (installResult.code !== 0) {
    claudeStep.stop('✗ Claude CLI install failed');
    p.cancel(installResult.stderr.slice(0, 1000));
    process.exit(1);
  }
  claudeStep.stop('✓ Claude CLI installed');

  // Step 5 — Copy local Claude config if the user has one.
  const localClaudeDir = path.join(os.homedir(), '.claude');
  if (fs.existsSync(localClaudeDir) && fs.statSync(localClaudeDir).isDirectory()) {
    const copyStep = p.spinner();
    copyStep.start('Copying local Claude config to workspace…');
    try {
      await provider.uploadDirectory(workspace.id, localClaudeDir, '/home/codespace/.claude');
      copyStep.stop('✓ Claude config copied — no re-auth needed');
    } catch (err) {
      copyStep.stop('⚠ Could not copy Claude config — you may need to login on the workspace');
      // Non-fatal; continue. The remote codeam pair will still work,
      // the user just has to `claude login` themselves.
      void err;
    }
  } else {
    p.note(
      'No local ~/.claude config found. You can authenticate Claude in the workspace shell when needed.',
      'Heads up',
    );
  }

  // Step 6 — Install codeam-cli in the workspace so we can pair.
  const cliStep = p.spinner();
  cliStep.start('Installing codeam-cli on workspace…');
  const cliInstall = await provider.exec(workspace.id, 'npm install -g codeam-cli@latest');
  if (cliInstall.code !== 0) {
    cliStep.stop('✗ codeam-cli install failed');
    p.cancel(cliInstall.stderr.slice(0, 1000));
    process.exit(1);
  }
  cliStep.stop('✓ codeam-cli installed');

  // Step 7 — Stream `codeam pair` from the workspace. The QR + pairing
  // code render straight to this local terminal because gh codespace ssh
  // forwards stdio and `-t` keeps ANSI escapes intact.
  p.note(
    [
      `Workspace: ${pc.cyan(workspace.displayName ?? workspace.id)}`,
      workspace.webUrl ? `Web:       ${pc.cyan(workspace.webUrl)}` : '',
      '',
      'Starting `codeam pair` on the workspace.',
      'Scan the QR code below with the CodeAgent Mobile app to finish pairing.',
    ]
      .filter(Boolean)
      .join('\n'),
    'Almost there',
  );

  const code = (await provider.streamCommand(workspace.id, 'codeam pair')).code;
  if (code === 0) {
    p.outro(pc.green(`✓ Workspace deployed and paired. Drive from your phone, anywhere.`));
  } else {
    p.outro(pc.yellow(`Pairing exited with code ${code}. Run "codeam pair" inside the codespace if needed.`));
  }
}

/**
 * Show the user a picker of providers — disabled rows for the
 * "coming soon" entries so they see the roadmap. Returns the chosen
 * provider, or `null` if the user cancels.
 */
async function pickProvider(): Promise<CloudProvider | null> {
  // Skip the picker when there's only one available provider — saves
  // the user a tap they don't need today.
  const ready = PROVIDERS.filter((prov) => prov.available);
  if (ready.length === 1) return ready[0];

  const selection = await p.select<string>({
    message: 'Where do you want to deploy?',
    options: PROVIDERS.map((prov) => ({
      value: prov.id,
      label: prov.available ? prov.displayName : `${prov.displayName} ${pc.dim('(coming soon)')}`,
      hint: prov.tagline,
    })),
  });
  if (p.isCancel(selection) || typeof selection !== 'string') return null;
  const found = PROVIDERS.find((prov) => prov.id === selection);
  if (!found || !found.available) {
    p.note(
      `${found?.displayName ?? 'That provider'} isn’t implemented yet — we'll ping you on Twitter/X when it ships.`,
      'Heads up',
    );
    return null;
  }
  return found;
}
