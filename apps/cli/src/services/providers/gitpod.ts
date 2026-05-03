import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type {
  CloudProvider,
  DeployableProject,
  ExecResult,
  ExistingWorkspace,
  MachineType,
  UploadDirectoryOptions,
  UploadFileOptions,
  Workspace,
} from './types';

const execFileP = promisify(execFile);
const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Gitpod backend.
 *
 * We delegate to the official `gitpod` CLI (https://github.com/gitpod-io/gitpod-cli)
 * for authentication, workspace lifecycle, and SSH access — the same
 * pattern used by the GitHub Codespaces provider with `gh`. Reasons:
 *   - Gitpod's auth is OAuth + PATs; re-implementing here is days of
 *     work and a security surface we don't want to own.
 *   - `gitpod workspace ssh` already handles connection brokering,
 *     port forwarding, and TTY allocation.
 *   - Users who already have `gitpod` set up (most current Gitpod
 *     users) get instant zero-config deploy.
 *
 * Heads up: Gitpod has been transitioning from "Gitpod Classic"
 * (gitpod.io SaaS) to "Gitpod Flex" (self-hosted). Both speak the
 * same `gitpod` CLI, so this provider works against either as long
 * as the CLI is configured to point at the right control plane
 * (`gitpod context` for Flex orgs).
 */
function resetStdinForChild(): void {
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
  }
}

export class GitpodProvider implements CloudProvider {
  readonly id = 'gitpod';
  readonly displayName = 'Gitpod';
  readonly tagline = 'Cloud dev environments from any Git repo';
  readonly available = true;

  async authorize(): Promise<void> {
    // Step 1: gitpod CLI installed?
    try {
      await execFileP('gitpod', ['--version'], { maxBuffer: MAX_BUFFER });
    } catch {
      throw new Error(
        [
          'Gitpod CLI (`gitpod`) is required for Gitpod deploys.',
          'Install it with one of:',
          '  • macOS:  brew install gitpod-io/tap/gitpod',
          '  • Other:  https://github.com/gitpod-io/gitpod-cli#installation',
          'Then run `gitpod login` and try `codeam deploy` again.',
        ].join('\n'),
      );
    }
    // Step 2: gitpod authed? `gitpod whoami` returns 0 when authed.
    try {
      await execFileP('gitpod', ['whoami'], { maxBuffer: MAX_BUFFER });
      return;
    } catch {
      /* fall through to interactive login */
    }
    // Step 3: interactive login. Stdio is inherited so the user can
    // answer the OAuth prompts.
    p.note(
      'A login URL will print below. Open it in your browser and approve.',
      'Authenticating Gitpod',
    );
    resetStdinForChild();
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('gitpod', ['login'], { stdio: 'inherit' });
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error('gitpod login failed.'));
      });
      proc.on('error', reject);
    });
  }

  async listProjects(): Promise<DeployableProject[]> {
    // `gitpod` CLI doesn't have a "list every repo I can see" command
    // — Gitpod is repo-URL-driven (any repo URL is fair game). We
    // surface what we can: existing workspaces' repo URLs, treated
    // as "recently used" projects, plus the user's own GitHub repos
    // if they're piped through Gitpod's identity. For first-time
    // users with no workspaces, the list will be empty and the
    // expandListScopes path (or just typing a URL when supported)
    // is the way forward.
    try {
      const { stdout } = await execFileP(
        'gitpod',
        ['workspace', 'list', '--output', 'json', '--limit', '200'],
        { maxBuffer: MAX_BUFFER },
      );
      interface RawWorkspace {
        id: string;
        contextUrl?: string;
        description?: string;
      }
      const list = JSON.parse(stdout) as RawWorkspace[];
      const seen = new Set<string>();
      const projects: DeployableProject[] = [];
      for (const w of list) {
        const url = w.contextUrl ?? '';
        if (!url || seen.has(url)) continue;
        seen.add(url);
        // Pull out `<host>/<owner>/<repo>` from the URL.
        const m = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/.+)?$/);
        if (!m) continue;
        const fullName = `${m[2]}/${m[3]}`;
        projects.push({
          id: url,                   // Gitpod indexes workspaces by URL
          name: m[3],
          fullName,
          description: w.description,
          private: false,            // Gitpod doesn't expose visibility here
        });
      }
      return projects;
    } catch {
      return [];
    }
  }

  async createWorkspace(
    projectId: string,
    machineTypeId?: string,
  ): Promise<Workspace> {
    // `gitpod workspace create` accepts a repo URL and starts a
    // fresh workspace. Optional `--class` flag picks the machine
    // class.
    const args = ['workspace', 'create', projectId, '--start', '--output', 'json'];
    if (machineTypeId) args.push('--class', machineTypeId);
    const { stdout } = await execFileP('gitpod', args, {
      maxBuffer: MAX_BUFFER,
      timeout: 300_000,
    });
    interface RawNew {
      id: string;
      url?: string;
    }
    let parsed: RawNew;
    try { parsed = JSON.parse(stdout) as RawNew; }
    catch { parsed = { id: stdout.trim() }; }
    if (!parsed.id) {
      throw new Error('Gitpod did not return a workspace id.');
    }
    await this.waitUntilRunning(parsed.id);
    return {
      id: parsed.id,
      displayName: parsed.id,
      webUrl: parsed.url ?? `https://gitpod.io/start/#${parsed.id}`,
    };
  }

  private async waitUntilRunning(workspaceId: string): Promise<void> {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      try {
        const { stdout } = await execFileP(
          'gitpod',
          ['workspace', 'get', workspaceId, '--output', 'json'],
          { maxBuffer: MAX_BUFFER },
        );
        const status = (JSON.parse(stdout) as { status?: string }).status?.toLowerCase() ?? '';
        if (status === 'running' || status === 'available') return;
        if (status === 'failed' || status === 'stopped') {
          throw new Error(`Gitpod workspace state: ${status}.`);
        }
      } catch {
        /* transient — keep polling */
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error('Gitpod workspace did not become Running within 5 minutes.');
  }

  async listMachineTypes(_projectId?: string): Promise<MachineType[]> {
    // Gitpod's machine classes are account-level (set in workspace
    // settings), not per-project. The CLI exposes them via
    // `gitpod organization list-classes`. Best-effort.
    try {
      const { stdout } = await execFileP(
        'gitpod',
        ['organization', 'list-classes', '--output', 'json'],
        { maxBuffer: MAX_BUFFER },
      );
      interface RawClass {
        id: string;
        displayName?: string;
        description?: string;
      }
      const list = JSON.parse(stdout) as RawClass[];
      // Gitpod doesn't expose precise GB / cores via this endpoint;
      // we return a default 8 GB so the caller's >=8 GB filter
      // doesn't drop everything. Users who need finer control set
      // their default class in the Gitpod org settings.
      return list.map<MachineType>((c) => ({
        id: c.id,
        label: c.displayName ?? c.id,
        memoryGb: 8,
      }));
    } catch {
      return [];
    }
  }

  async listExistingWorkspaces(projectId?: string): Promise<ExistingWorkspace[]> {
    try {
      const args = ['workspace', 'list', '--output', 'json', '--limit', '200'];
      const { stdout } = await execFileP('gitpod', args, { maxBuffer: MAX_BUFFER });
      interface RawWorkspace {
        id: string;
        contextUrl?: string;
        status?: string;
        lastActivity?: string;
      }
      const list = JSON.parse(stdout) as RawWorkspace[];
      return list
        .filter((w) => !projectId || w.contextUrl === projectId)
        .map<ExistingWorkspace>((w) => ({
          id: w.id,
          displayName: w.id,
          webUrl: `https://gitpod.io/start/#${w.id}`,
          state: w.status ?? 'Unknown',
          lastUsedAt: w.lastActivity,
        }));
    } catch {
      return [];
    }
  }

  async startWorkspace(workspaceId: string): Promise<Workspace> {
    try {
      await execFileP(
        'gitpod',
        ['workspace', 'start', workspaceId],
        { maxBuffer: MAX_BUFFER, timeout: 60_000 },
      );
    } catch {
      /* may already be running */
    }
    await this.waitUntilRunning(workspaceId);
    return {
      id: workspaceId,
      displayName: workspaceId,
      webUrl: `https://gitpod.io/start/#${workspaceId}`,
    };
  }

  async exec(workspaceId: string, command: string): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileP(
        'gitpod',
        ['workspace', 'ssh', workspaceId, '--', command],
        { maxBuffer: MAX_BUFFER, timeout: 600_000 },
      );
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? 'gitpod workspace ssh failed',
        code: typeof e.code === 'number' ? e.code : 1,
      };
    }
  }

  async streamCommand(workspaceId: string, command: string): Promise<{ code: number }> {
    resetStdinForChild();
    return new Promise((resolve, reject) => {
      const proc = spawn(
        'gitpod',
        ['workspace', 'ssh', workspaceId, '--', '-tt', command],
        { stdio: 'inherit' },
      );
      proc.on('exit', (code) => resolve({ code: code ?? 0 }));
      proc.on('error', reject);
    });
  }

  async uploadDirectory(
    workspaceId: string,
    localDir: string,
    remoteDir: string,
    options: UploadDirectoryOptions = {},
  ): Promise<void> {
    // Same tar-pipe pattern as the Codespaces provider — preserves
    // perms / dotfiles / symlinks and surfaces real stderr.
    const tarArgs = ['-czf', '-', '-C', localDir];
    for (const pattern of options.exclude ?? []) {
      tarArgs.push(`--exclude=${pattern}`);
      const stripped = pattern.replace(/^\.\/+/, '');
      if (stripped !== pattern) tarArgs.push(`--exclude=${stripped}`);
    }
    tarArgs.push('.');
    const tarEnv = { ...process.env, COPYFILE_DISABLE: '1' };
    const remoteCmd = `mkdir -p ${shellQuote(remoteDir)} && tar -xzf - -C ${shellQuote(remoteDir)}`;
    await new Promise<void>((resolve, reject) => {
      const tar = spawn('tar', tarArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: tarEnv,
      });
      const ssh = spawn(
        'gitpod',
        ['workspace', 'ssh', workspaceId, '--', remoteCmd],
        { stdio: [tar.stdout!, 'pipe', 'pipe'] },
      );
      let tarErr = '';
      let sshErr = '';
      tar.stderr?.on('data', (d) => { tarErr += d.toString(); });
      ssh.stderr?.on('data', (d) => { sshErr += d.toString(); });
      tar.on('error', reject);
      ssh.on('error', reject);
      ssh.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Remote tar failed: ${(sshErr || tarErr || `exit ${code}`).trim().slice(0, 500)}`));
      });
    });
  }

  async uploadFile(
    workspaceId: string,
    remotePath: string,
    contents: string | Buffer,
    options: UploadFileOptions = {},
  ): Promise<void> {
    const remoteDir = path.posix.dirname(remotePath);
    const parts = [
      `mkdir -p ${shellQuote(remoteDir)}`,
      `cat > ${shellQuote(remotePath)}`,
    ];
    if (options.mode != null) {
      parts.push(`chmod ${options.mode.toString(8)} ${shellQuote(remotePath)}`);
    }
    const cmd = parts.join(' && ');
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        'gitpod',
        ['workspace', 'ssh', workspaceId, '--', cmd],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let stderr = '';
      proc.stderr?.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Remote write failed: ${(stderr || `exit ${code}`).trim().slice(0, 500)}`));
      });
      proc.stdin?.write(contents);
      proc.stdin?.end();
    });
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

void pc; // reserved for future colored prompts
