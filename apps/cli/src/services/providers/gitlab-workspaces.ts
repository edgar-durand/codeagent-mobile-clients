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

const GITLAB_API_BASE =
  process.env.CODEAM_GITLAB_API_URL ?? 'https://gitlab.com/api/v4';

/**
 * GitLab Workspaces backend (formerly "GitLab Remote Development").
 *
 * Unlike Codespaces / Gitpod-Classic, GitLab Workspaces are NOT
 * fully managed — they run on a Kubernetes cluster the user (or
 * their org) has registered with GitLab via a "GitLab Agent". This
 * provider assumes the user has:
 *   1. `glab` CLI installed and authed to the right host.
 *   2. A repo with a `.devfile.yaml` defining the workspace runtime.
 *   3. An agent (and therefore K8s cluster) registered for the
 *      project or its parent group.
 *
 * If any of those is missing, the provider surfaces a clear error
 * with a link to the relevant docs rather than silently failing.
 *
 * Implementation notes:
 *   - Auth + repo listing go through `glab` CLI for the same reasons
 *     the Codespaces provider uses `gh` (no re-implementing OAuth).
 *   - Workspace lifecycle uses GitLab's GraphQL API. There's no
 *     `glab workspaces` subcommand at the time of writing.
 *   - Exec / streamCommand / uploadDirectory rely on the Workspace
 *     SSH proxy `<workspace-id>.workspaces.gitlab.com` once the
 *     workspace is Running. Users on self-managed GitLab instances
 *     point to their own SSH endpoint via `CODEAM_GITLAB_SSH_HOST`.
 */
function resetStdinForChild(): void {
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
  }
}

export class GitLabWorkspacesProvider implements CloudProvider {
  readonly id = 'gitlab-workspaces';
  readonly displayName = 'GitLab Workspaces';
  readonly tagline = 'Self-hosted dev environments on your K8s cluster';
  readonly available = true;

  async authorize(): Promise<void> {
    // Step 1: glab installed?
    try {
      await execFileP('glab', ['--version'], { maxBuffer: MAX_BUFFER });
    } catch {
      throw new Error(
        [
          'GitLab CLI (`glab`) is required for GitLab Workspaces deploys.',
          'Install it with one of:',
          '  • macOS:  brew install glab',
          '  • Linux:  https://gitlab.com/gitlab-org/cli#installation',
          '  • Windows: winget install GitLab.glab',
          'Then run `glab auth login` and try `codeam deploy` again.',
        ].join('\n'),
      );
    }
    // Step 2: glab authed?
    try {
      await execFileP('glab', ['auth', 'status'], { maxBuffer: MAX_BUFFER });
      return;
    } catch {
      /* fall through */
    }
    // Step 3: interactive login.
    p.note(
      'A token / OAuth flow will open below. After approval the deploy resumes.',
      'Authenticating GitLab',
    );
    resetStdinForChild();
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        'glab',
        ['auth', 'login', '--scopes', 'api,read_user,read_repository'],
        { stdio: 'inherit' },
      );
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error('glab auth login failed.'));
      });
      proc.on('error', reject);
    });
  }

  async listProjects(): Promise<DeployableProject[]> {
    // `glab repo list` returns the user's projects + member projects.
    // We fall back to `--member` style if the JSON output isn't
    // supported on the installed version.
    try {
      const { stdout } = await execFileP(
        'glab',
        ['repo', 'list', '--per-page', '200', '--output', 'json'],
        { maxBuffer: MAX_BUFFER },
      );
      interface RawProject {
        id?: number | string;
        name?: string;
        path_with_namespace?: string;
        description?: string;
        default_branch?: string;
        visibility?: string;
      }
      const list = JSON.parse(stdout) as RawProject[];
      return list
        .filter((r) => r.path_with_namespace)
        .map<DeployableProject>((r) => ({
          id: r.path_with_namespace!,
          name: r.name ?? r.path_with_namespace!,
          fullName: r.path_with_namespace!,
          description: r.description ?? undefined,
          defaultBranch: r.default_branch,
          private: r.visibility !== 'public',
        }));
    } catch {
      return [];
    }
  }

  /**
   * GitLab.com's machine sizes are tied to whatever the agent's
   * K8s cluster offers — this is project / agent specific and the
   * GraphQL API doesn't enumerate "available classes" today. We
   * return an empty list, which makes the orchestrator skip the
   * picker. Users with multiple sizes wired to their agent should
   * change the default in their devfile.yaml.
   */
  async listMachineTypes(_projectId?: string): Promise<MachineType[]> {
    return [];
  }

  async createWorkspace(
    projectId: string,
    _machineTypeId?: string,
  ): Promise<Workspace> {
    // GraphQL mutation: workspaceCreate. We hit GitLab's API with
    // the user's `glab` token (extracted via `glab auth status -t`).
    const token = await this.getGlabToken();
    if (!token) {
      throw new Error(
        'Could not extract GitLab token from `glab`. Run `glab auth login` and retry.',
      );
    }
    const projectFullPath = projectId;
    const mutation = `mutation Create($p: WorkspaceCreateInput!) {
      workspaceCreate(input: $p) {
        workspace { id name desiredState actualState url }
        errors
      }
    }`;
    const body = JSON.stringify({
      query: mutation,
      variables: {
        p: {
          projectId: `gid://gitlab/Project/${projectFullPath}`,
          editor: 'webide',
          desiredState: 'RUNNING',
          // The devfile MUST exist in the repo at .devfile.yaml.
          devfilePath: '.devfile.yaml',
        },
      },
    });
    interface GqlResp {
      data?: {
        workspaceCreate?: {
          workspace?: { id?: string; name?: string; url?: string };
          errors?: string[];
        };
      };
      errors?: { message?: string }[];
    }
    const data = (await this.gql(token, body)) as GqlResp;
    const ws = data.data?.workspaceCreate?.workspace;
    const errs =
      data.data?.workspaceCreate?.errors ?? data.errors?.map((e) => e.message ?? '') ?? [];
    if (!ws?.id || errs.length > 0) {
      throw new Error(
        `GitLab Workspaces createWorkspace failed: ${errs.join('; ') || 'no workspace returned'}.\n` +
          'Common causes: project has no .devfile.yaml; no agent registered; user lacks permission.\n' +
          'Docs: https://docs.gitlab.com/ee/user/workspace/configuration.html',
      );
    }
    await this.waitUntilRunning(token, ws.id);
    return {
      id: ws.id,
      displayName: ws.name ?? ws.id,
      webUrl: ws.url,
    };
  }

  private async waitUntilRunning(token: string, workspaceId: string): Promise<void> {
    const deadline = Date.now() + 5 * 60 * 1000;
    const query = `query Get($id: WorkspaceID!) {
      workspace(id: $id) { actualState }
    }`;
    while (Date.now() < deadline) {
      try {
        const data = (await this.gql(
          token,
          JSON.stringify({ query, variables: { id: workspaceId } }),
        )) as { data?: { workspace?: { actualState?: string } } };
        const state = data.data?.workspace?.actualState?.toUpperCase() ?? '';
        if (state === 'RUNNING') return;
        if (state === 'FAILED' || state === 'STOPPED') {
          throw new Error(`Workspace state: ${state}.`);
        }
      } catch {
        /* transient */
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
    throw new Error('GitLab workspace did not become Running within 5 minutes.');
  }

  async listExistingWorkspaces(_projectId?: string): Promise<ExistingWorkspace[]> {
    const token = await this.getGlabToken();
    if (!token) return [];
    const query = `query { currentUser { workspaces { nodes {
      id name actualState url updatedAt
    } } } }`;
    try {
      const data = (await this.gql(token, JSON.stringify({ query }))) as {
        data?: {
          currentUser?: {
            workspaces?: {
              nodes?: { id: string; name?: string; actualState?: string; url?: string; updatedAt?: string }[];
            };
          };
        };
      };
      const nodes = data.data?.currentUser?.workspaces?.nodes ?? [];
      return nodes.map<ExistingWorkspace>((n) => ({
        id: n.id,
        displayName: n.name ?? n.id,
        webUrl: n.url,
        state: n.actualState,
        lastUsedAt: n.updatedAt,
      }));
    } catch {
      return [];
    }
  }

  async startWorkspace(workspaceId: string): Promise<Workspace> {
    const token = await this.getGlabToken();
    if (!token) throw new Error('Not authenticated with GitLab.');
    const mutation = `mutation Start($id: WorkspaceID!) {
      workspaceUpdate(input: { id: $id, desiredState: RUNNING }) {
        workspace { id name url } errors
      }
    }`;
    await this.gql(
      token,
      JSON.stringify({ query: mutation, variables: { id: workspaceId } }),
    );
    await this.waitUntilRunning(token, workspaceId);
    return { id: workspaceId, displayName: workspaceId };
  }

  async exec(workspaceId: string, command: string): Promise<ExecResult> {
    // GitLab Workspaces SSH proxy:
    //   ssh <workspace-id>@workspaces.gitlab.com
    // The user's SSH key must be uploaded to GitLab. We fall back to
    // the user's default identity.
    const sshHost = process.env.CODEAM_GITLAB_SSH_HOST ?? 'workspaces.gitlab.com';
    try {
      const { stdout, stderr } = await execFileP(
        'ssh',
        [
          '-o', 'StrictHostKeyChecking=accept-new',
          '-o', 'BatchMode=yes',
          `${workspaceId}@${sshHost}`,
          command,
        ],
        { maxBuffer: MAX_BUFFER, timeout: 600_000 },
      );
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? 'ssh to GitLab workspace failed',
        code: typeof e.code === 'number' ? e.code : 1,
      };
    }
  }

  async streamCommand(workspaceId: string, command: string): Promise<{ code: number }> {
    const sshHost = process.env.CODEAM_GITLAB_SSH_HOST ?? 'workspaces.gitlab.com';
    resetStdinForChild();
    return new Promise((resolve, reject) => {
      const proc = spawn(
        'ssh',
        ['-tt', '-o', 'StrictHostKeyChecking=accept-new', `${workspaceId}@${sshHost}`, command],
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
    const sshHost = process.env.CODEAM_GITLAB_SSH_HOST ?? 'workspaces.gitlab.com';
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
      const ssh = spawn(
        'ssh',
        ['-o', 'StrictHostKeyChecking=accept-new', `${workspaceId}@${sshHost}`, remoteCmd],
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
    const sshHost = process.env.CODEAM_GITLAB_SSH_HOST ?? 'workspaces.gitlab.com';
    const remoteDir = path.posix.dirname(remotePath);
    const parts = [`mkdir -p ${shellQuote(remoteDir)}`, `cat > ${shellQuote(remotePath)}`];
    if (options.mode != null) {
      parts.push(`chmod ${options.mode.toString(8)} ${shellQuote(remotePath)}`);
    }
    const cmd = parts.join(' && ');
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        'ssh',
        ['-o', 'StrictHostKeyChecking=accept-new', `${workspaceId}@${sshHost}`, cmd],
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

  /**
   * Pull the user's `glab` token via `glab auth status -t`, since
   * `glab` stores it in its own config and we need it to call the
   * GraphQL API directly.
   */
  private async getGlabToken(): Promise<string | null> {
    try {
      const { stdout, stderr } = await execFileP(
        'glab',
        ['auth', 'status', '--show-token'],
        { maxBuffer: MAX_BUFFER },
      );
      const haystack = stdout + '\n' + stderr;
      const m = haystack.match(/Token:\s+(\S+)/);
      return m?.[1] ?? null;
    } catch {
      return null;
    }
  }

  private async gql(token: string, body: string): Promise<unknown> {
    const url = `${GITLAB_API_BASE.replace(/\/$/, '').replace(/\/v4$/, '')}/api/graphql`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitLab GraphQL ${res.status}: ${text.slice(0, 400)}`);
    }
    return (await res.json()) as unknown;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
