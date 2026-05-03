import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import type { CloudProvider, DeployableProject, ExecResult, Workspace } from './types';

const execFileP = promisify(execFile);

const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * GitHub Codespaces backend. We layer over the official `gh` CLI rather
 * than calling the REST API directly because:
 *   - `gh` already handles OAuth (device flow, browser handoff, scope
 *     prompts) — re-implementing that here is days of work and a
 *     security surface we don't want to own.
 *   - `gh codespace ssh` is the path of least friction for streaming
 *     output / TTY support / file copy. Building our own websocket
 *     tunnel would replicate work the team at GitHub already shipped.
 *   - Users who already have `gh` set up (which is 99% of the developer
 *     market we're targeting) get instant zero-config deploy.
 *
 * Falls back gracefully when `gh` isn't present: the `authorize()` step
 * tells the user how to install it and links to the docs.
 */
export class GitHubCodespacesProvider implements CloudProvider {
  readonly id = 'github-codespaces';
  readonly displayName = 'GitHub Codespaces';
  readonly tagline = 'Cloud dev environment from any GitHub repo';
  readonly available = true;

  async authorize(): Promise<void> {
    // Step 1: gh installed?
    try {
      await execFileP('gh', ['--version'], { maxBuffer: MAX_BUFFER });
    } catch {
      throw new Error(
        [
          'GitHub CLI (`gh`) is required for Codespaces deploys.',
          'Install it with:',
          '  • macOS:   brew install gh',
          '  • Linux:   https://github.com/cli/cli/blob/trunk/docs/install_linux.md',
          '  • Windows: winget install --id GitHub.cli',
          'Then run `gh auth login` and try `codeam deploy` again.',
        ].join('\n'),
      );
    }
    // Step 2: gh authed?
    try {
      await execFileP('gh', ['auth', 'status'], { maxBuffer: MAX_BUFFER });
      return;
    } catch {
      // Fall through to interactive login below.
    }
    // Step 3: run `gh auth login` interactively. Stdio is inherited so
    // the user can answer the device-flow prompts.
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('gh', ['auth', 'login', '-s', 'codespace,repo,read:user'], {
        stdio: 'inherit',
      });
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error('gh auth login failed.'));
      });
      proc.on('error', reject);
    });
  }

  async listProjects(): Promise<DeployableProject[]> {
    const { stdout } = await execFileP(
      'gh',
      [
        'repo', 'list',
        '--json', 'name,nameWithOwner,description,defaultBranchRef,isPrivate',
        '--limit', '200',
      ],
      { maxBuffer: MAX_BUFFER },
    );
    interface RawRepo {
      name: string;
      nameWithOwner: string;
      description?: string;
      defaultBranchRef?: { name?: string };
      isPrivate?: boolean;
    }
    const raw = JSON.parse(stdout) as RawRepo[];
    return raw.map((r) => ({
      id: r.nameWithOwner,
      name: r.name,
      fullName: r.nameWithOwner,
      description: r.description ?? undefined,
      defaultBranch: r.defaultBranchRef?.name,
      private: !!r.isPrivate,
    }));
  }

  async createWorkspace(projectId: string): Promise<Workspace> {
    // `gh codespace create` returns the codespace name on stdout.
    // `--default-permissions` skips the "Authorize repository access?"
    // browser prompt for repos with default permissions configured.
    const { stdout } = await execFileP(
      'gh',
      ['codespace', 'create', '-R', projectId, '--default-permissions'],
      { maxBuffer: MAX_BUFFER, timeout: 120_000 },
    );
    const name = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    if (!name) {
      throw new Error('GitHub did not return a codespace name.');
    }
    // Wait until the codespace state is `Available` (ready to SSH).
    await this.waitUntilAvailable(name);
    return {
      id: name,
      displayName: name,
      webUrl: `https://github.com/codespaces/${name}`,
    };
  }

  private async waitUntilAvailable(name: string): Promise<void> {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      const { stdout } = await execFileP(
        'gh',
        ['codespace', 'list', '--json', 'name,state'],
        { maxBuffer: MAX_BUFFER },
      );
      const list = JSON.parse(stdout) as Array<{ name: string; state: string }>;
      const me = list.find((c) => c.name === name);
      if (!me) throw new Error('Codespace disappeared from the list.');
      if (me.state === 'Available') return;
      if (me.state === 'Failed' || me.state === 'Unavailable') {
        throw new Error(`Codespace state: ${me.state}.`);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error('Codespace did not become Available within 5 minutes.');
  }

  async exec(workspaceId: string, command: string): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileP(
        'gh',
        ['codespace', 'ssh', '-c', workspaceId, '--', command],
        { maxBuffer: MAX_BUFFER, timeout: 600_000 },
      );
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? 'gh codespace ssh failed',
        code: typeof e.code === 'number' ? e.code : 1,
      };
    }
  }

  async streamCommand(workspaceId: string, command: string): Promise<{ code: number }> {
    return new Promise((resolve, reject) => {
      // `-t` allocates a TTY so ANSI escapes (color, QR-code drawing,
      // cursor positioning) come through cleanly. `--` separates the
      // remote command from gh's own flags.
      const proc = spawn(
        'gh',
        ['codespace', 'ssh', '-c', workspaceId, '-t', '--', command],
        { stdio: 'inherit' },
      );
      proc.on('exit', (code) => resolve({ code: code ?? 0 }));
      proc.on('error', reject);
    });
  }

  async uploadDirectory(workspaceId: string, localDir: string, remoteDir: string): Promise<void> {
    // `gh codespace cp -r <local> remote:<path> -c <name>` does a
    // recursive copy. The `remote:` prefix is required.
    await execFileP(
      'gh',
      ['codespace', 'cp', '-r', '-c', workspaceId, localDir, `remote:${remoteDir}`],
      { maxBuffer: MAX_BUFFER, timeout: 300_000 },
    );
  }
}
