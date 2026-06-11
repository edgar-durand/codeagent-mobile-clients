import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  BeadsIssueDto,
  BeadsStatusSummary,
  BeadsIssueStatus,
} from '@codeagent/shared';
import { log } from '../services/logger';

/**
 * The single wrapper around every `bd` invocation (churn-isolation per spec
 * §7 — Beads is young, so all bd surface area lives behind this one adapter
 * and a version pin). Resolution order, cross-OS:
 *
 *   1. the bundled `@beads/bd` binary (its postinstall fetched the correct
 *      prebuilt native binary per platform — darwin/linux amd64+arm64,
 *      windows-amd64). Resolved from the installed package, NOT PATH.
 *   2. `bd` already on PATH (a user who installed bd themselves).
 *   3. a consented OS-detected installer (see `install-bd.ts`) — handled by
 *      the caller, not here; `resolveBinary()` simply returns null so the
 *      caller can offer the installer.
 *
 * All bd state lives in the home-level "brain" at `~/.beads`, addressed via the
 * `BEADS_DIR` env var bd reads, and served by ONE shared `dolt sql-server`.
 *
 * CORRECTION (spec §3c, D15 — supersedes the 2026-06-09 spike): the npm-bundled
 * `@beads/bd` is the SERVER-mode build, NOT an embedded engine. Every DB
 * operation — `bd remember`/`memories`/`prime`(+memories) especially — needs
 * the standalone `dolt` binary + a running `dolt sql-server`; the old "embedded
 * home brain needs no external dolt" assumption was false and left memory
 * silently dead. So `run()` sets `BEADS_DOLT_SHARED_SERVER=1` on every command
 * (one shared server at `~/.beads/shared-server`, port 3308) and per-repo
 * isolation is by per-project database name (the `prefix`), NOT `--global`
 * (which we still never pass). The provisioner installs dolt + owns the server
 * + inits the per-prefix DB. Tests pass an explicit `beadsDir` to redirect off
 * the real home brain.
 */

const BD_PACKAGE = '@beads/bd';

export interface BdRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface BdAdapterOptions {
  /**
   * Working directory bd runs in. bd resolves the repo prefix / origin from
   * here even under `--global`, so this should be the user's project dir.
   */
  cwd?: string;
  /**
   * Override the resolved binary (tests; also lets a caller pass a path
   * obtained from a just-run installer). When omitted the adapter resolves
   * bundled → PATH on first use.
   */
  binaryPath?: string;
  /**
   * The home brain directory bd addresses via `BEADS_DIR`. Defaults to
   * `~/.beads` (the verified embedded home brain). Tests pass an explicit dir
   * so they never touch the real home brain.
   */
  beadsDir?: string;
}

/**
 * Resolve the `@beads/bd` native binary from the installed package. The npm
 * shim (`bin/bd.js`) spawns `<pkg>/bin/bd` (or `bd.exe` on Windows) after its
 * postinstall downloads it — we resolve that same binary directly so we skip
 * the extra node process per call.
 *
 * Returns the absolute binary path, or null when the package isn't resolvable
 * or the platform binary hasn't been downloaded (offline / proxy / unsupported
 * arch — the caller then offers the installer).
 *
 * Exposed via `_resolveSeam` so tests can stub `require.resolve` + `fs` without
 * a full `vi.mock`.
 */
export function resolveBundledBdBinary(): string | null {
  return _resolveSeam.resolveBundled();
}

function _defaultResolveBundled(): string | null {
  let pkgJsonPath: string;
  try {
    // Resolve the installed @beads/bd package.json, then walk to its bin dir.
    pkgJsonPath = require.resolve(`${BD_PACKAGE}/package.json`);
  } catch {
    return null;
  }
  const binDir = path.join(path.dirname(pkgJsonPath), 'bin');
  const binaryName = process.platform === 'win32' ? 'bd.exe' : 'bd';
  const binaryPath = path.join(binDir, binaryName);
  try {
    fs.accessSync(binaryPath, fs.constants.F_OK);
    return binaryPath;
  } catch {
    // Package installed but the platform binary wasn't downloaded
    // (postinstall failed: proxy, air-gapped, unsupported arch). The
    // caller falls through to PATH / installer.
    return null;
  }
}

/**
 * Resolve `bd` on the user's PATH (case 2). Probes PATHEXT-style candidates on
 * Windows (`bd.exe`, `bd.cmd`, `bd`). Returns the absolute path or null.
 */
export function resolveBdOnPath(): string | null {
  return _resolveSeam.resolveOnPath();
}

function _defaultResolveOnPath(): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const candidates =
    process.platform === 'win32' ? ['bd.exe', 'bd.cmd', 'bd'] : ['bd'];
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        fs.accessSync(full, fs.constants.F_OK);
        return full;
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

export const _resolveSeam = {
  resolveBundled: _defaultResolveBundled,
  resolveOnPath: _defaultResolveOnPath,
};

/**
 * Test seam for spawning — lets vitest intercept the actual child_process call
 * without `vi.mock('child_process')` (which would touch the file-watcher and
 * agent runtimes too).
 */
export const _spawnSeam = {
  run: _defaultSpawn,
};

function _defaultSpawn(
  binaryPath: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv },
): Promise<BdRunResult> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(binaryPath, args, { cwd: opts.cwd, env: opts.env });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: (err as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    proc.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
    proc.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export class BdAdapter {
  private resolved: string | null;

  constructor(private readonly opts: BdAdapterOptions = {}) {
    this.resolved = opts.binaryPath ?? null;
  }

  /**
   * Resolve the bd binary lazily, caching the result. Order:
   * bundled @beads/bd → PATH. Returns null when neither is available — the
   * caller offers the consented installer (`install-bd.ts`).
   */
  resolveBinary(): string | null {
    if (this.resolved) return this.resolved;
    const bundled = resolveBundledBdBinary();
    if (bundled) {
      this.resolved = bundled;
      return bundled;
    }
    const onPath = resolveBdOnPath();
    if (onPath) {
      this.resolved = onPath;
      return onPath;
    }
    return null;
  }

  /** True when a bd binary is resolvable without installing. */
  isAvailable(): boolean {
    return this.resolveBinary() !== null;
  }

  /**
   * Run an arbitrary bd subcommand against the home brain. `BEADS_DIR` is set
   * to the configured `beadsDir` (tests) or `~/.beads` (the verified embedded
   * home brain) so every command resolves to the same single graph regardless
   * of the process cwd. Returns the raw result; callers decide how to interpret
   * exit codes — note bd exits 0 even for some error states (e.g. "no beads
   * database found"), so JSON-parsing callers must also inspect the payload.
   */
  async run(args: string[]): Promise<BdRunResult> {
    const binary = this.resolveBinary();
    if (!binary) {
      return { code: -1, stdout: '', stderr: 'bd binary not resolved' };
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    env.BEADS_DIR = this.opts.beadsDir ?? defaultBeadsHomeDir();
    // Shared-server mode: the npm-bundled @beads/bd is the server-mode build,
    // so every DB op (memory included) must target the shared dolt sql-server
    // at ~/.beads/shared-server (port 3308). Without this, bd tries an embedded
    // engine and fails "dolt is not installed". (Spec §3c, D15.)
    env.BEADS_DOLT_SHARED_SERVER = '1';
    log.trace('beads', `bd ${args.join(' ')} (BEADS_DIR=${env.BEADS_DIR}, shared-server)`);
    return _spawnSeam.run(binary, args, { cwd: this.opts.cwd, env });
  }

  /**
   * `bd ready --json` → typed issue array. `bd list --json` shares the shape,
   * so `listIssues` reuses the same parser. Bad JSON / non-zero exit → [].
   */
  async readyIssues(projectKey: string): Promise<BeadsIssueDto[]> {
    const res = await this.run(['ready', '--json']);
    return parseIssues(res, projectKey);
  }

  async listIssues(projectKey: string): Promise<BeadsIssueDto[]> {
    const res = await this.run(['list', '--json']);
    return parseIssues(res, projectKey);
  }

  /** `bd status --json` → summary block, or null on failure. */
  async statusSummary(): Promise<BeadsStatusSummary | null> {
    const res = await this.run(['status', '--json']);
    if (res.code !== 0) return null;
    try {
      const parsed = JSON.parse(res.stdout) as { summary?: BeadsStatusSummary };
      return parsed.summary ?? null;
    } catch {
      return null;
    }
  }
}

const VALID_STATUS = new Set<BeadsIssueStatus>([
  'open',
  'in_progress',
  'blocked',
  'closed',
]);

/**
 * Parse `bd ready/list --json` output (an array of raw issue objects) and tag
 * each with the caller-supplied `projectKey`. Tolerant: a non-zero exit, bad
 * JSON, or a non-array payload yields []; individual rows missing required
 * fields are skipped rather than poisoning the whole batch.
 */
function parseIssues(res: BdRunResult, projectKey: string): BeadsIssueDto[] {
  if (res.code !== 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: BeadsIssueDto[] = [];
  for (const row of parsed) {
    const issue = coerceIssue(row, projectKey);
    if (issue) out.push(issue);
  }
  return out;
}

function coerceIssue(row: unknown, projectKey: string): BeadsIssueDto | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.title !== 'string') return null;
  const status =
    typeof r.status === 'string' && VALID_STATUS.has(r.status as BeadsIssueStatus)
      ? (r.status as BeadsIssueStatus)
      : 'open';
  return {
    id: r.id,
    title: r.title,
    status,
    priority: typeof r.priority === 'number' ? r.priority : null,
    issue_type: typeof r.issue_type === 'string' ? r.issue_type : 'task',
    owner: typeof r.owner === 'string' && r.owner.length > 0 ? r.owner : null,
    created_at: typeof r.created_at === 'string' ? r.created_at : '',
    updated_at: typeof r.updated_at === 'string' ? r.updated_at : '',
    dependency_count:
      typeof r.dependency_count === 'number' ? r.dependency_count : undefined,
    dependent_count:
      typeof r.dependent_count === 'number' ? r.dependent_count : undefined,
    comment_count:
      typeof r.comment_count === 'number' ? r.comment_count : undefined,
    projectKey,
  };
}

/** Convenience constructor used by callers that don't need custom options. */
export function createBdAdapter(opts: BdAdapterOptions = {}): BdAdapter {
  return new BdAdapter(opts);
}

/** Re-exported so callers can probe the home-brain dir without hardcoding. */
export function defaultBeadsHomeDir(): string {
  return path.join(os.homedir(), '.beads');
}
