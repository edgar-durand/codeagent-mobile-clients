import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { CloudProvider, DeployableProject, ExecResult, ExistingWorkspace, MachineType, Workspace } from './types';

const execFileP = promisify(execFile);

const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Restore stdin to canonical (line-buffered) mode before handing the
 * terminal to an interactive subprocess. clack's prompts (`select`,
 * `confirm`, …) put stdin in raw mode while they're active and don't
 * always restore canonical mode cleanly afterward — which means a
 * child invoked with `stdio: 'inherit'` reads byte-by-byte instead of
 * a line per Enter, so its readline-style prompts (`gh auth login`,
 * `gh auth refresh`) silently swallow keystrokes and look hung.
 *
 * Calling this right before each `spawn(..., { stdio: 'inherit' })`
 * is cheap and removes the entire class of bug.
 */
function resetStdinForChild(): void {
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // Some terminals don't support raw mode toggling; nothing to do.
    }
  }
}

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
    // Step 1: gh installed? If not, offer to install it for the user
    // — opt-in so we never sudo / brew without permission.
    try {
      await execFileP('gh', ['--version'], { maxBuffer: MAX_BUFFER });
    } catch {
      await this.tryInstallGh();
      // Re-check after the install attempt.
      try {
        await execFileP('gh', ['--version'], { maxBuffer: MAX_BUFFER });
      } catch {
        throw new Error(
          [
            'GitHub CLI (`gh`) is still not on PATH.',
            'Install it manually with:',
            '  • macOS:   brew install gh',
            '  • Linux:   https://github.com/cli/cli/blob/trunk/docs/install_linux.md',
            '  • Windows: winget install --id GitHub.cli',
            'Then run `codeam deploy` again.',
          ].join('\n'),
        );
      }
    }
    // Step 2: gh authed?
    let isAuthed = false;
    try {
      await execFileP('gh', ['auth', 'status'], { maxBuffer: MAX_BUFFER });
      isAuthed = true;
    } catch {
      // Not authed — fall through to interactive login below.
    }

    if (!isAuthed) {
      // Step 3a: run `gh auth login` interactively. Stdio is inherited
      // so the user can answer the device-flow prompts. We pass the
      // exact scopes Codespaces needs so the granted token works for
      // the rest of the deploy without a second auth round-trip.
      resetStdinForChild();
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
      return;
    }

    // Step 3b: already authed — but the token may be missing the
    // `codespace` scope (e.g. the user ran `gh auth login` long ago
    // before Codespaces existed, or chose a narrower scope set). That
    // would explode mid-deploy with HTTP 404 from `/user/codespaces`.
    // Detect it up front and offer to refresh.
    const hasScope = await this.hasCodespaceScope();
    if (!hasScope) {
      // Pre-flight: figure out which GitHub account the user needs to
      // pick in the browser. The most common reason `gh auth refresh`
      // fails on the first try is a different account being signed in
      // on github.com (multi-account setups, work + personal, etc.) —
      // gh refuses to swap identities silently. Showing the expected
      // login up front avoids that round-trip.
      const expectedUser = await this.getActiveGhUser();
      const noteLines = [
        'Your existing GitHub login is missing the `codespace` scope.',
        'I\'ll run `gh auth refresh` to add it — your browser will open',
        'for a one-tap approval.',
      ];
      if (expectedUser) {
        noteLines.push('');
        noteLines.push(
          `${pc.yellow('⚠')}  Sign in as ${pc.cyan(expectedUser)} in the browser.`,
        );
        noteLines.push(
          '   If a different GitHub account is already signed in, sign out',
        );
        noteLines.push(
          '   of it first — or open the URL in an incognito/private window.',
        );
      }
      p.note(noteLines.join('\n'), 'One more permission needed');
      resetStdinForChild();
      const refreshCode = await new Promise<number>((resolve, reject) => {
        const proc = spawn(
          'gh',
          ['auth', 'refresh', '-h', 'github.com', '-s', 'codespace'],
          { stdio: 'inherit' },
        );
        proc.on('exit', (code) => resolve(code ?? 1));
        proc.on('error', reject);
      });
      if (refreshCode !== 0) {
        // Most common failure today: the user authed as the wrong
        // GitHub account in the browser, and gh's stderr says
        // "received credentials for X, did you use the correct
        // account?". Give that resolution path top billing rather
        // than a generic "try again manually".
        const lines = [
          'The browser approval came back for a different GitHub account',
          `than the one gh is configured for${expectedUser ? ` (${pc.cyan(expectedUser)})` : ''}.`,
          '',
          'To recover:',
          '  1. Open https://github.com and sign out of any non-target',
          `     account${expectedUser ? ` (or open the URL in an incognito window)` : ''}.`,
          '  2. Re-run codeam deploy.',
          '',
          'You can also grant the scope manually first and skip this step',
          'on the next run:',
          `  ${pc.cyan('gh auth refresh -h github.com -s codespace')}`,
        ];
        throw new Error(lines.join('\n'));
      }
    }
  }

  /**
   * Return the GitHub login that the current `gh` token belongs to,
   * or `null` if the call fails. Used to tell the user which account
   * they need to authenticate as in the browser when refreshing
   * scopes — multi-account browser sessions are the #1 cause of
   * `gh auth refresh` failures.
   */
  private async getActiveGhUser(): Promise<string | null> {
    try {
      const { stdout } = await execFileP(
        'gh',
        ['api', 'user', '--jq', '.login'],
        { maxBuffer: MAX_BUFFER },
      );
      const login = stdout.trim();
      return login.length > 0 ? login : null;
    } catch {
      return null;
    }
  }

  /**
   * Check whether the current `gh` token includes the `codespace`
   * OAuth scope. We hit `/user` with `-i` so GitHub echoes the granted
   * scopes back in the `X-OAuth-Scopes` response header — the most
   * authoritative source (more reliable than scraping `gh auth status`,
   * whose format has shifted across `gh` versions).
   */
  private async hasCodespaceScope(): Promise<boolean> {
    try {
      const { stdout } = await execFileP(
        'gh',
        ['api', '-i', 'user'],
        { maxBuffer: MAX_BUFFER },
      );
      const m = stdout.match(/^x-oauth-scopes:\s*(.+)$/im);
      if (!m) return false;
      const scopes = m[1].split(',').map((s) => s.trim().toLowerCase());
      return scopes.includes('codespace');
    } catch {
      // If the API call fails for any reason, assume the scope is
      // missing — the worst case is one extra `gh auth refresh` round
      // that grants the scope cleanly.
      return false;
    }
  }

  /**
   * Try to install the `gh` CLI for the user. Opt-in via a confirm
   * prompt — we never run `brew` / `winget` / `apt` without explicit
   * consent. Strategy per platform:
   *
   *   - macOS:   `brew install gh` (requires Homebrew)
   *   - Windows: `winget install --id GitHub.cli -e --silent`
   *   - Linux:   too many distros / package managers to be safe; we
   *              point the user at the official install doc instead.
   *
   * Stdio is inherited so any sudo / authentication prompt the package
   * manager surfaces (e.g. macOS keychain, Windows UAC) lands in this
   * terminal. On failure or an unsupported platform we just return —
   * the caller will re-check `gh --version` and surface the manual-
   * install error if it's still missing.
   */
  private async tryInstallGh(): Promise<void> {
    const platform = process.platform;
    p.note(
      `GitHub CLI (${pc.cyan('gh')}) is required for Codespaces deploys but isn't on your PATH.`,
      'Heads up',
    );

    if (platform === 'linux') {
      // Linux package managers vary too much (apt vs dnf vs pacman vs
      // apk, and most need sudo + a third-party repo for a current
      // gh). Pointing the user at the official installer is safer.
      p.note(
        [
          'On Linux, please install gh from the official guide:',
          '  https://github.com/cli/cli/blob/trunk/docs/install_linux.md',
          'Re-run `codeam deploy` once it is on your PATH.',
        ].join('\n'),
        'Install gh on Linux',
      );
      return;
    }

    let installCmd: { exe: string; args: string[]; describe: string } | null = null;
    if (platform === 'darwin') {
      // brew is the de-facto package manager on macOS dev machines —
      // bail out early if it isn't installed so we don't get a cryptic
      // "command not found" mid-install.
      try {
        await execFileP('brew', ['--version'], { maxBuffer: MAX_BUFFER });
      } catch {
        p.note(
          [
            'Homebrew (`brew`) is not installed.',
            'Install it from https://brew.sh and re-run `codeam deploy`,',
            'or install gh manually: https://cli.github.com/',
          ].join('\n'),
          'Cannot auto-install on macOS',
        );
        return;
      }
      installCmd = {
        exe: 'brew',
        args: ['install', 'gh'],
        describe: 'brew install gh',
      };
    } else if (platform === 'win32') {
      try {
        await execFileP('winget', ['--version'], { maxBuffer: MAX_BUFFER });
      } catch {
        p.note(
          [
            'winget is not available on this machine.',
            'Install gh manually: https://github.com/cli/cli/releases/latest',
          ].join('\n'),
          'Cannot auto-install on Windows',
        );
        return;
      }
      installCmd = {
        exe: 'winget',
        args: ['install', '--id', 'GitHub.cli', '-e', '--silent'],
        describe: 'winget install --id GitHub.cli',
      };
    } else {
      // Unknown platform — let the caller's manual-instruction error fire.
      return;
    }

    const proceed = await p.confirm({
      message: `Run ${pc.cyan(installCmd.describe)} now?`,
      initialValue: true,
    });
    if (p.isCancel(proceed) || !proceed) return;

    // No clack spinner here — the package manager streams progress
    // (download bars, post-install scripts) that need the terminal.
    p.log.step(`Installing gh via ${installCmd.describe}…`);
    resetStdinForChild();
    const ok = await new Promise<boolean>((resolve) => {
      const proc = spawn(installCmd.exe, installCmd.args, { stdio: 'inherit' });
      proc.on('exit', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
    if (ok) p.log.success('gh installed');
    else p.log.error('gh install failed');
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

  /**
   * Return the machine types available to the user for this repo. The
   * `gh api /repos/.../codespaces/machines` endpoint reports CPU / RAM /
   * storage, so we hand all three to the picker for a clean label.
   *
   * We filter out anything below 8 GB RAM — Claude Code wants headroom
   * for `tsc`, build tools, and parallel test runners; the 4 GB tier
   * (when available) is too tight in practice.
   */
  async listMachineTypes(projectId: string): Promise<MachineType[]> {
    try {
      const { stdout } = await execFileP(
        'gh',
        ['api', `/repos/${projectId}/codespaces/machines`],
        { maxBuffer: MAX_BUFFER },
      );
      const data = JSON.parse(stdout) as {
        machines?: Array<{
          name: string;
          display_name?: string;
          cpus?: number;
          memory_in_bytes?: number;
          storage_in_bytes?: number;
        }>;
      };
      const machines = data.machines ?? [];
      const GB = 1024 ** 3;
      return machines
        .map<MachineType>((m) => {
          const memoryGb = m.memory_in_bytes ? Math.round(m.memory_in_bytes / GB) : 0;
          const storageGb = m.storage_in_bytes ? Math.round(m.storage_in_bytes / GB) : undefined;
          const parts: string[] = [];
          if (m.cpus) parts.push(`${m.cpus} ${m.cpus === 1 ? 'core' : 'cores'}`);
          if (memoryGb) parts.push(`${memoryGb} GB RAM`);
          if (storageGb) parts.push(`${storageGb} GB storage`);
          return {
            id: m.name,
            label: m.display_name ?? (parts.join(' · ') || m.name),
            memoryGb,
            cpus: m.cpus,
            storageGb,
          };
        })
        .filter((m) => m.memoryGb >= 8)
        .sort((a, b) => a.memoryGb - b.memoryGb || (a.cpus ?? 0) - (b.cpus ?? 0));
    } catch {
      return [];
    }
  }

  async createWorkspace(projectId: string, machineTypeId?: string): Promise<Workspace> {
    // `gh codespace create` returns the codespace name on stdout.
    // `--default-permissions` skips the "Authorize repository access?"
    // browser prompt for repos with default permissions configured.
    //
    // We MUST pass `-m <machine>` here. Without it, `gh` tries to prompt
    // the user interactively to pick a machine type — and since we shell
    // out via `execFile` with no TTY, that prompt fails with
    // `error getting machine type: error getting machine: no terminal`.
    const machine = machineTypeId ?? (await this.pickDefaultMachine(projectId));
    const args = ['codespace', 'create', '-R', projectId, '--default-permissions'];
    if (machine) args.push('-m', machine);
    const { stdout } = await execFileP(
      'gh',
      args,
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

  /**
   * Fallback machine picker for when the orchestrator didn't ask the
   * user — defaults to the cheapest 8 GB tier (`basicLinux32gb`) and
   * walks up only if the repo restricts that tier. Returns `null` if
   * the API call fails entirely; the caller will then omit `-m` and
   * let `gh` use the repo/org default.
   */
  private async pickDefaultMachine(projectId: string): Promise<string | null> {
    const machines = await this.listMachineTypes(projectId);
    if (machines.length === 0) return null;
    const preferenceOrder = [
      'basicLinux32gb',
      'standardLinux32gb',
      'premiumLinux',
      'largePremiumLinux',
    ];
    for (const pref of preferenceOrder) {
      if (machines.some((m) => m.id === pref)) return pref;
    }
    return machines[0].id;
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
    resetStdinForChild();
    return new Promise((resolve, reject) => {
      // `-tt` is an SSH flag (force-allocate a TTY even with stdin
      // attached), NOT a gh flag — it must come AFTER `--`. The TTY
      // is what lets `codeam pair`'s QR-code drawing, cursor moves
      // and `claude login`'s code prompt render and read input.
      const proc = spawn(
        'gh',
        ['codespace', 'ssh', '-c', workspaceId, '--', '-tt', command],
        { stdio: 'inherit' },
      );
      proc.on('exit', (code) => resolve({ code: code ?? 0 }));
      proc.on('error', reject);
    });
  }

  async uploadDirectory(workspaceId: string, localDir: string, remoteDir: string): Promise<void> {
    // We deliberately avoid `gh codespace cp` here. Two reasons:
    //   1. It silently swallows useful errors — failures bubble up as
    //      a generic non-zero exit with no stderr surfaced to the
    //      orchestrator, so the user sees "Could not copy Claude
    //      config" with no clue why.
    //   2. It's flaky on directories that don't pre-exist on the
    //      remote, on dotfiles, and on permission edges.
    //
    // Instead, stream a tar of the local directory through ssh's
    // stdin and untar on the remote — the canonical "pipe a tarball"
    // pattern. This:
    //   - creates the remote directory if missing (`mkdir -p`)
    //   - preserves perms / hidden files / symlinks
    //   - surfaces tar / ssh stderr if anything goes wrong
    //   - works exactly the same on macOS, Linux, and inside Codespaces
    const sshArgs = [
      'codespace', 'ssh', '-c', workspaceId, '--',
      `mkdir -p ${shellQuote(remoteDir)} && tar -xzf - -C ${shellQuote(remoteDir)}`,
    ];
    await new Promise<void>((resolve, reject) => {
      const tar = spawn('tar', ['-czf', '-', '-C', localDir, '.'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const ssh = spawn('gh', sshArgs, {
        stdio: [tar.stdout!, 'pipe', 'pipe'],
      });
      let tarErr = '';
      let sshErr = '';
      tar.stderr?.on('data', (d) => { tarErr += d.toString(); });
      ssh.stderr?.on('data', (d) => { sshErr += d.toString(); });
      tar.on('error', reject);
      ssh.on('error', reject);
      ssh.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          const reason = (sshErr || tarErr || `exit ${code}`).trim().slice(0, 500);
          reject(new Error(`Remote tar failed: ${reason}`));
        }
      });
    });
  }

  async listExistingWorkspaces(projectId: string): Promise<ExistingWorkspace[]> {
    // `--repo` filters to a single repo; `--json` gives us machine-
    // readable output. We use `displayName` (human-readable) as the
    // label and `name` (the stable id used by every other gh API).
    try {
      const { stdout } = await execFileP(
        'gh',
        [
          'codespace', 'list',
          '--repo', projectId,
          '--json', 'name,displayName,state,lastUsedAt',
        ],
        { maxBuffer: MAX_BUFFER },
      );
      interface RawCodespace {
        name: string;
        displayName?: string;
        state?: string;
        lastUsedAt?: string;
      }
      const list = JSON.parse(stdout) as RawCodespace[];
      return list.map<ExistingWorkspace>((c) => ({
        id: c.name,
        displayName: c.displayName || c.name,
        webUrl: `https://github.com/codespaces/${c.name}`,
        state: c.state,
        lastUsedAt: c.lastUsedAt,
      }));
    } catch {
      return [];
    }
  }

  async startWorkspace(workspaceId: string): Promise<Workspace> {
    // `gh codespace` doesn't expose a `start` subcommand; the public
    // REST endpoint is the way. Posting to /user/codespaces/<name>/start
    // queues a wake — we then poll `gh codespace list` until the
    // state flips to `Available`, same logic the new-workspace path
    // already uses.
    try {
      await execFileP(
        'gh',
        ['api', '-X', 'POST', `/user/codespaces/${workspaceId}/start`],
        { maxBuffer: MAX_BUFFER, timeout: 60_000 },
      );
    } catch (err) {
      // Some states (already Available) make /start return 304 / 422 —
      // those aren't real failures. Fall through to the polling step;
      // if it really is broken, the poll will surface it.
      void err;
    }
    await this.waitUntilAvailable(workspaceId);
    return {
      id: workspaceId,
      displayName: workspaceId,
      webUrl: `https://github.com/codespaces/${workspaceId}`,
    };
  }
}

/**
 * Single-quote a string for safe inclusion in a remote shell command.
 * The escaping rule: `'` → `'\''`, then wrap the whole thing in `'…'`.
 * Used when constructing the inline `mkdir … && tar …` we ship to the
 * codespace via `gh codespace ssh -- '…'`.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
