import {
  execFile,
  execFileSync,
  type ExecFileOptions,
  type ExecFileSyncOptions,
} from 'child_process';

/**
 * Detect the current git branch of `cwd`. Returns the branch name on
 * success, or `null` when:
 *
 *   - `cwd` is not inside a git repository
 *   - `HEAD` is detached (e.g. `git checkout <sha>`) — `git branch
 *     --show-current` prints an empty string
 *   - `git` is not installed or otherwise fails to execute
 *
 * The CLI ships this value to the backend on `codeam pair` so the
 * mobile app can label the paired session with the branch that was
 * checked out when the session was established. Without it, mobile
 * shows "—" for every session.
 *
 * `git branch --show-current` walks up from `cwd` to find the repo
 * root, so this works in subdirectories of the repo (e.g. a user who
 * paired from `apps/cli/` still gets the repo's current branch).
 *
 * The implementation uses `execFileSync` (not `execSync`) so the
 * args are passed as an explicit argv array, never via a shell. On
 * Windows `execSync('git branch --show-current', …)` is routed
 * through cmd.exe which re-tokenises the string — today no user
 * input flows into the command, but the pattern is one careless
 * `${branch}` interpolation away from injection. `execFileSync`
 * removes the foot-gun entirely.
 *
 * The seam (`_execSeam.exec`) lets tests stub the underlying call
 * without having to wire `vi.mock('child_process')` (which is awkward
 * because other modules in the codebase use `spawn` / `execFileSync`).
 */
export function detectCurrentBranch(cwd: string = process.cwd()): string | null {
  try {
    const raw = _execSeam.exec('git', ['branch', '--show-current'], {
      cwd,
      // 1 s ceiling is comfortably above normal git latency (<50 ms
      // on a healthy repo) and well below the pair POST's 10 s budget.
      timeout: 1000,
      // Swallow stderr — non-git directories print "fatal: not a git
      // repository" to stderr and we don't want that on the CLI's
      // own stderr while pairing.
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    const trimmed = raw.trim();
    // `git branch --show-current` returns an empty string on
    // detached HEAD. Treat empty as "no branch" so the backend can
    // store `null` instead of `""`.
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // Not a git repo, git missing, timeout, or any other failure.
    return null;
  }
}

/**
 * Indirection layer that lets tests stub `execFileSync` without
 * resorting to a `vi.mock('child_process')` that would touch every
 * other module in the dependency graph.
 */
export const _execSeam = {
  exec: (file: string, args: readonly string[], opts: ExecFileSyncOptions): string => {
    const out = execFileSync(file, args, opts);
    return typeof out === 'string' ? out : out.toString('utf8');
  },
};

/**
 * Async sibling of {@link _execSeam.exec}, backed by the non-blocking
 * `execFile`. The recurring 20 s heartbeat refreshes the branch
 * through this seam so a slow `git` (a repo holding `index.lock`
 * during a long agent tool call, a network filesystem) can NEVER
 * stall the event loop and delay the heartbeat — the heartbeat must
 * stay punctual INDEPENDENTLY of whatever turn is in flight. Tests
 * stub `_execSeamAsync.exec` the same way they stub the sync seam.
 */
export const _execSeamAsync = {
  exec: (file: string, args: readonly string[], opts: ExecFileOptions): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(file, args, opts, (err, stdout) => {
        if (err) reject(err);
        else resolve(typeof stdout === 'string' ? stdout : stdout.toString('utf8'));
      });
    }),
};

/**
 * Non-blocking variant of {@link detectCurrentBranch}. Same contract
 * (branch name, or `null` for detached HEAD / non-repo / failure) but
 * spawns `git` asynchronously so the caller's event loop is never
 * blocked. Used by the heartbeat's off-hot-path branch refresh.
 */
export async function detectCurrentBranchAsync(
  cwd: string = process.cwd(),
): Promise<string | null> {
  try {
    const raw = await _execSeamAsync.exec('git', ['branch', '--show-current'], {
      cwd,
      timeout: 1000,
      encoding: 'utf8',
      windowsHide: true,
    });
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // Not a git repo, git missing, timeout, or any other failure.
    return null;
  }
}
