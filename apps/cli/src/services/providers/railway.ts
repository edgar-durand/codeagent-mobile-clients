import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as p from '@clack/prompts';
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
 * Railway backend.
 *
 * Railway is a PaaS, not a "cloud dev environment" product — but
 * because `codeam-cli` only needs a long-running terminal (no IDE),
 * we can repurpose Railway's container model perfectly: each
 * deploy becomes a Railway service that runs `codeam pair` as its
 * entrypoint, supervised by Railway's own infra. Cheap, fast,
 * generous free tier, and SSH-equivalent shell access via
 * `railway shell`.
 *
 * Trade-offs vs GitHub Codespaces / Gitpod:
 *   + No K8s setup, no devcontainer / devfile to maintain.
 *   + Railway runs the container 24×7 by default — ideal for the
 *     "agent always-on, accessible from your phone" use case.
 *   - No persistent home dir between deploys (volumes are opt-in).
 *   - The user's local Claude config still ships via tar each
 *     deploy, just like the other providers.
 *
 * The provider leans on the Railway CLI for all auth + control:
 *   - `railway login`        → OAuth flow
 *   - `railway list`         → user's projects
 *   - `railway up`           → deploy code as a service
 *   - `railway shell`        → exec / interactive
 *   - `railway run <cmd>`    → one-shot exec inside service env
 *
 * Implementation note: Railway's CLI doesn't expose a clean way to
 * stream stdin into a remote command (no equivalent of
 * `gh codespace cp`). For uploadDirectory we rely on `railway shell`
 * piping a tar stream through stdin — works because `shell` opens
 * a remote bash with the user's stdin attached.
 */
function resetStdinForChild(): void {
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
  }
}

export class RailwayProvider implements CloudProvider {
  readonly id = 'railway';
  readonly displayName = 'Railway';
  readonly tagline = 'Always-on container — no IDE, just an agent terminal';
  readonly available = true;

  async authorize(): Promise<void> {
    // Step 1: railway CLI installed?
    try {
      await execFileP('railway', ['--version'], { maxBuffer: MAX_BUFFER });
    } catch {
      throw new Error(
        [
          'Railway CLI (`railway`) is required for Railway deploys.',
          'Install it with one of:',
          '  • npm:    npm install -g @railway/cli',
          '  • macOS:  brew install railway',
          '  • Linux:  https://docs.railway.app/develop/cli#install',
          'Then run `railway login` and try `codeam deploy` again.',
        ].join('\n'),
      );
    }
    // Step 2: railway authed?
    try {
      await execFileP('railway', ['whoami'], { maxBuffer: MAX_BUFFER });
      return;
    } catch {
      /* fall through */
    }
    // Step 3: interactive login.
    p.note(
      'A login URL prints below. Open it in your browser and approve.',
      'Authenticating Railway',
    );
    resetStdinForChild();
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('railway', ['login'], { stdio: 'inherit' });
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error('railway login failed.'));
      });
      proc.on('error', reject);
    });
  }

  async listProjects(): Promise<DeployableProject[]> {
    // `railway list --json` returns the user's projects across all
    // workspaces they belong to. Older CLIs only support `railway
    // list` without --json; we parse both.
    try {
      const { stdout } = await execFileP(
        'railway',
        ['list', '--json'],
        { maxBuffer: MAX_BUFFER },
      );
      interface RawProject {
        id?: string;
        name?: string;
        description?: string;
      }
      const list = JSON.parse(stdout) as RawProject[];
      return list
        .filter((r) => r.id && r.name)
        .map<DeployableProject>((r) => ({
          id: r.id!,
          name: r.name!,
          fullName: r.name!,
          description: r.description ?? undefined,
          private: true, // Railway projects are private by default
        }));
    } catch {
      // Fallback: parse plain text output.
      try {
        const { stdout } = await execFileP('railway', ['list'], { maxBuffer: MAX_BUFFER });
        const projects: DeployableProject[] = [];
        for (const line of stdout.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('Project')) continue;
          // Railway prints "name: <name>  id: <id>" on each line.
          const idMatch = trimmed.match(/id:\s*(\S+)/);
          const nameMatch = trimmed.match(/name:\s*([^|]+)/);
          if (idMatch && nameMatch) {
            const name = nameMatch[1].trim();
            projects.push({
              id: idMatch[1],
              name,
              fullName: name,
              private: true,
            });
          }
        }
        return projects;
      } catch {
        return [];
      }
    }
  }

  /**
   * Railway exposes resource sizes (CPU / RAM) at the SERVICE level,
   * not the project level — and only on paid plans. The CLI has no
   * `list-classes` equivalent today. Returning empty makes the
   * orchestrator skip the picker; users on paid plans can resize
   * a service from the Railway dashboard after deploy.
   */
  async listMachineTypes(_projectId?: string): Promise<MachineType[]> {
    return [];
  }

  async createWorkspace(_projectId: string, _machineTypeId?: string): Promise<Workspace> {
    // Railway model: a "deployment" is a service inside a project.
    // We `railway link` to the chosen project, then `railway up`
    // pushes a small bootstrap directory whose start command runs
    // `codeam pair` (kept alive automatically by Railway's runtime).
    //
    // For the MVP we DON'T `railway up` here — that needs a local
    // working directory the user wants pushed. Instead we treat the
    // existing services in the project as candidate workspaces
    // (`listExistingWorkspaces` enumerates them) and let the user
    // pick. If none exist, we surface an actionable error.
    p.note(
      [
        'Railway service auto-creation from `codeam deploy` isn\'t implemented yet.',
        'Workaround for now:',
        '  1. From your repo:  railway link  (pick this project)',
        '  2. Run:             railway up --detach',
        '  3. Re-run codeam deploy and pick the existing service.',
      ].join('\n'),
      'Heads up — manual step needed',
    );
    throw new Error(
      'Railway provider needs an existing service to attach to. See the note above.',
    );
  }

  async listExistingWorkspaces(projectId?: string): Promise<ExistingWorkspace[]> {
    if (!projectId) return [];
    try {
      const { stdout } = await execFileP(
        'railway',
        ['service', 'list', '--project', projectId, '--json'],
        { maxBuffer: MAX_BUFFER },
      );
      interface RawService {
        id?: string;
        name?: string;
        deployments?: { status?: string; updatedAt?: string }[];
      }
      const list = JSON.parse(stdout) as RawService[];
      return list
        .filter((s) => s.id && s.name)
        .map<ExistingWorkspace>((s) => {
          const latest = s.deployments?.[0];
          return {
            id: `${projectId}/${s.id}`,
            displayName: s.name!,
            state: latest?.status ?? 'Unknown',
            lastUsedAt: latest?.updatedAt,
          };
        });
    } catch {
      return [];
    }
  }

  async startWorkspace(workspaceId: string): Promise<Workspace> {
    // Railway services don't really "stop" the way a Codespace
    // does — they're scaled to 0 replicas instead. `railway service
    // restart` covers the wake-up case.
    const [projectId, serviceId] = workspaceId.split('/');
    if (!projectId || !serviceId) {
      throw new Error('Invalid Railway workspace id (expected projectId/serviceId).');
    }
    try {
      await execFileP(
        'railway',
        ['service', 'restart', '--service', serviceId, '--project', projectId],
        { maxBuffer: MAX_BUFFER, timeout: 60_000 },
      );
    } catch {
      /* may already be running */
    }
    return { id: workspaceId, displayName: serviceId };
  }

  async exec(workspaceId: string, command: string): Promise<ExecResult> {
    const [projectId, serviceId] = workspaceId.split('/');
    if (!projectId || !serviceId) {
      return {
        stdout: '',
        stderr: 'Invalid Railway workspace id (expected projectId/serviceId).',
        code: 1,
      };
    }
    try {
      const { stdout, stderr } = await execFileP(
        'railway',
        ['run', '--project', projectId, '--service', serviceId, '--', 'bash', '-lc', command],
        { maxBuffer: MAX_BUFFER, timeout: 600_000 },
      );
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? 'railway run failed',
        code: typeof e.code === 'number' ? e.code : 1,
      };
    }
  }

  async streamCommand(workspaceId: string, command: string): Promise<{ code: number }> {
    const [projectId, serviceId] = workspaceId.split('/');
    if (!projectId || !serviceId) {
      throw new Error('Invalid Railway workspace id (expected projectId/serviceId).');
    }
    resetStdinForChild();
    return new Promise((resolve, reject) => {
      const proc = spawn(
        'railway',
        ['shell', '--project', projectId, '--service', serviceId, '--command', command],
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
    const [projectId, serviceId] = workspaceId.split('/');
    if (!projectId || !serviceId) {
      throw new Error('Invalid Railway workspace id (expected projectId/serviceId).');
    }
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
      const tar = spawn('tar', tarArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: tarEnv });
      const sh = spawn(
        'railway',
        ['shell', '--project', projectId, '--service', serviceId, '--command', remoteCmd],
        { stdio: [tar.stdout!, 'pipe', 'pipe'] },
      );
      let tarErr = '';
      let shErr = '';
      tar.stderr?.on('data', (d) => { tarErr += d.toString(); });
      sh.stderr?.on('data', (d) => { shErr += d.toString(); });
      tar.on('error', reject);
      sh.on('error', reject);
      sh.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Remote tar failed: ${(shErr || tarErr || `exit ${code}`).trim().slice(0, 500)}`));
      });
    });
  }

  async uploadFile(
    workspaceId: string,
    remotePath: string,
    contents: string | Buffer,
    options: UploadFileOptions = {},
  ): Promise<void> {
    const [projectId, serviceId] = workspaceId.split('/');
    if (!projectId || !serviceId) {
      throw new Error('Invalid Railway workspace id (expected projectId/serviceId).');
    }
    const remoteDir = path.posix.dirname(remotePath);
    const parts = [`mkdir -p ${shellQuote(remoteDir)}`, `cat > ${shellQuote(remotePath)}`];
    if (options.mode != null) {
      parts.push(`chmod ${options.mode.toString(8)} ${shellQuote(remotePath)}`);
    }
    const cmd = parts.join(' && ');
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        'railway',
        ['shell', '--project', projectId, '--service', serviceId, '--command', cmd],
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
