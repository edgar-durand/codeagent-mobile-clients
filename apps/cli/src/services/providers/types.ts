/**
 * Cloud-workspace provider interface. Every backend (GitHub Codespaces,
 * future GitLab WebIDE / Coder / Gitpod / etc.) implements the same
 * shape so `codeam deploy` can switch between them without rewriting
 * the orchestrator.
 *
 * Design notes:
 *   - Authorization is per-provider and side-effecting (may open a
 *     browser, run device-flow OAuth, prompt for a PAT, or shell out to
 *     a CLI like `gh`). The orchestrator only calls `authorize()` once
 *     up front and trusts that subsequent calls have credentials.
 *   - `listProjects` returns the user's deployable projects (repos for
 *     git-based providers, templates for others). Pagination is the
 *     provider's problem; the orchestrator gets the full list back.
 *   - `createWorkspace` is async-blocking until the workspace is in a
 *     state where we can `exec()` against it. The provider is free to
 *     poll its own API to wait for "ready".
 *   - `exec` is one-shot: synchronous-style, captures full output,
 *     suitable for setup steps (install scripts, config copies).
 *   - `streamCommand` runs a command and streams its stdout to the
 *     orchestrator's stdout. Used for `codeam pair` so the QR + code
 *     show up in the local terminal as the remote process renders them.
 *   - `uploadDirectory` copies a *recursive* local dir to a remote
 *     path. Used to seed the codespace with the user's `~/.claude/`
 *     credentials so they don't have to re-auth.
 */

export interface DeployableProject {
  /** Stable identifier the provider's API uses (e.g. `owner/repo`). */
  id: string;
  /** Display name (e.g. `repo`). */
  name: string;
  /** Long form for the user to disambiguate (e.g. `owner/repo`). */
  fullName: string;
  description?: string;
  defaultBranch?: string;
  private?: boolean;
}

export interface Workspace {
  /** Provider-issued workspace identifier (e.g. codespace name). */
  id: string;
  /** Optional display label (e.g. `stunning-bassoon-xyz123`). */
  displayName?: string;
  /** Optional URL the user can open in a browser to inspect. */
  webUrl?: string;
}

/**
 * Existing workspace found for a project — used by `codeam deploy` to
 * offer "reuse existing or create new?" instead of always spinning up
 * a fresh one. Adds runtime metadata (state, last activity) so the
 * picker can show useful hints next to each option.
 */
export interface ExistingWorkspace extends Workspace {
  /** Provider state (e.g. 'Available', 'Stopped', 'Starting', 'Shutdown'). */
  state?: string;
  /** ISO timestamp of the last activity, if the provider exposes it. */
  lastUsedAt?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * A machine / instance type the provider can spin up. Returned from
 * `listMachineTypes` so the orchestrator can let the user pick. Memory
 * is in GB so the picker can render "8 GB" without doing math.
 */
export interface MachineType {
  /** Provider-issued id passed back to `createWorkspace`. */
  id: string;
  /** User-facing label (e.g. "2 cores · 8 GB RAM · 32 GB storage"). */
  label: string;
  /** Memory in GB — used to filter to a minimum. */
  memoryGb: number;
  /** CPU core count, if known. */
  cpus?: number;
  /** Storage in GB, if known. */
  storageGb?: number;
}

export interface CloudProvider {
  /** Stable id used for selection (e.g. `github-codespaces`). */
  readonly id: string;
  /** User-facing name (e.g. `GitHub Codespaces`). */
  readonly displayName: string;
  /** Short tagline shown next to the name in the picker. */
  readonly tagline?: string;
  /** True when the provider is fully implemented; false → "coming soon". */
  readonly available: boolean;

  /**
   * Verify or acquire the credentials needed for the rest of the API.
   * Resolves on success; rejects with a user-friendly message on failure.
   */
  authorize(): Promise<void>;

  /** Return the user's deployable projects. */
  listProjects(): Promise<DeployableProject[]>;

  /**
   * Expand the OAuth scopes used for listing projects. Used when the
   * user can't find their target repo in `listProjects` because it
   * lives in an org / team they need extra scopes to see (e.g.
   * `read:org` on GitHub). Optional — providers without
   * extensible-scope OAuth (or that already grant everything by
   * default) can omit this. Resolves once the new scopes are in
   * effect; the orchestrator then re-runs `listProjects()`.
   */
  expandListScopes?(): Promise<void>;

  /**
   * Return the machine types available to the user for this project.
   * Optional — providers that don't expose machine selection (or where
   * the concept doesn't apply) can omit this. The orchestrator will
   * skip the picker when it's missing or returns an empty array.
   */
  listMachineTypes?(projectId: string): Promise<MachineType[]>;

  /**
   * Create a new workspace from a project. Resolves once the workspace
   * is ready to accept `exec` and `streamCommand` calls. `machineTypeId`
   * is forwarded if the provider supports machine selection.
   */
  createWorkspace(projectId: string, machineTypeId?: string): Promise<Workspace>;

  /**
   * Return existing workspaces the user has. With `projectId` set, the
   * result is filtered to that project; with no argument, return ALL
   * workspaces across the user's account (used by `codeam deploy
   * stop` to manage sessions globally). Optional — providers without
   * a "list workspaces" concept can omit it.
   */
  listExistingWorkspaces?(projectId?: string): Promise<ExistingWorkspace[]>;

  /**
   * Bring an existing workspace back to a usable state (e.g. start a
   * stopped codespace). Resolves once it is ready for `exec` /
   * `streamCommand`. Optional — providers that always keep workspaces
   * hot can omit it.
   */
  startWorkspace?(workspaceId: string): Promise<Workspace>;

  /** Run a single command in the workspace and return all of its output. */
  exec(workspaceId: string, command: string): Promise<ExecResult>;

  /**
   * Run a command and stream its stdout/stderr to the local terminal.
   * Inherits stdio so ANSI escapes (color, QR codes, cursor moves)
   * pass through unchanged. Resolves when the remote process exits.
   */
  streamCommand(workspaceId: string, command: string): Promise<{ code: number }>;

  /**
   * Recursive copy of a local directory to a remote path inside the
   * workspace. `options.exclude` lets callers skip heavy / irrelevant
   * subpaths (e.g. local conversation history, caches) so we don't
   * waste minutes uploading files the remote will never read. Patterns
   * are interpreted as `tar --exclude` globs (relative to `localDir`).
   */
  uploadDirectory(
    workspaceId: string,
    localDir: string,
    remoteDir: string,
    options?: UploadDirectoryOptions,
  ): Promise<void>;

  /**
   * Write a single file to the workspace from a string / buffer the
   * caller already has in memory. Used for ferrying secrets that
   * don't live on the local filesystem (e.g. macOS Keychain entries
   * that Claude stores there instead of as a flat file). Creates the
   * parent directory if missing.
   */
  uploadFile(
    workspaceId: string,
    remotePath: string,
    contents: string | Buffer,
    options?: UploadFileOptions,
  ): Promise<void>;
}

export interface UploadDirectoryOptions {
  /** Glob patterns to skip during the upload (tar `--exclude` syntax). */
  exclude?: string[];
}

export interface UploadFileOptions {
  /** Octal file mode to chmod the destination to (e.g. 0o600 for secrets). */
  mode?: number;
}
