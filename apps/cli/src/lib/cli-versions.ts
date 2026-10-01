// src/lib/cli-versions.ts
//
// Versioned, side-by-side codeam-cli installs for the self-updating host-agent.
//
// WHY (codeagent-siec, 2026-10-01): the host-agent used to self-update with
// `npm install -g codeam-cli@latest`, which rewrites the global package tree IN
// PLACE. A session child spawned while npm was mid-rewrite could load a
// half-written tree — and with the startup self-update check that window lands
// exactly when the first deploy after a wake arrives. Now every version gets its
// OWN directory and the switch is a single atomic rename:
//
//   ~/.codeam/cli/
//     <version>/node_modules/codeam-cli/dist/index.js   (npm install --prefix)
//     current  -> <version>     (atomic symlink swap: symlink tmp + rename)
//     previous -> <version>     (rollback target)
//
// A new version is installed + verified in its own `<version>/` directory, which
// nothing points at (and no redirect follows) until `current` is swapped to it.
//
// Nothing that is running is ever touched: a running process (and every child it
// spawns via `process.argv[1]`) uses the REAL path of its own version directory,
// which the install never writes and GC never removes while it is current,
// previous or the running one. How a process gets onto `current` regardless of
// which `codeam` was launched (Box image global install, `/tmp/codeam-node20/bin`,
// `~/.local/bin`, a systemd unit's fixed ExecStart) is `version-redirect.ts`.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compareSemver } from './updateNotifier';

const CLI_PKG = 'codeam-cli';
const SEMVER_DIR = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

/** Root of the versioned installs. `CODEAM_CLI_VERSIONS_DIR` overrides (tests). */
export function cliVersionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEAM_CLI_VERSIONS_DIR || path.join(os.homedir(), '.codeam', 'cli');
}

/** The installed package directory inside a version (or staging) directory. */
export function packageDirOf(versionDir: string): string {
  return path.join(versionDir, 'node_modules', CLI_PKG);
}

/**
 * The JS entry point of the package installed under `versionDir`, from its own
 * `package.json` `bin` field (falls back to `dist/index.js`). Null when the
 * package is missing or its entry file does not exist — i.e. not runnable.
 */
export function entryOf(versionDir: string): string | null {
  const pkgDir = packageDirOf(versionDir);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
      bin?: string | Record<string, string>;
    };
    const rel =
      typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.codeam ?? 'dist/index.js');
    const entry = path.join(pkgDir, rel);
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

/** `package.json` version of the package installed under `versionDir`. */
export function versionOf(versionDir: string): string | null {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(packageDirOf(versionDir), 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Absolute directory a pointer (`current` / `previous`) resolves to, or null. */
export function pointerTarget(root: string, name: 'current' | 'previous'): string | null {
  try {
    return fs.realpathSync(path.join(root, name));
  } catch {
    return null;
  }
}

/**
 * Atomically point `root/<name>` at `targetDir`: create a temp symlink, then
 * `rename(2)` it over the old one. A reader sees either the old target or the
 * new one, never a missing or half-written pointer.
 */
export function atomicPoint(root: string, name: 'current' | 'previous', targetDir: string): void {
  const tmp = path.join(root, `.${name}.tmp-${process.pid}-${Date.now()}`);
  fs.symlinkSync(path.relative(root, targetDir), tmp, 'dir');
  try {
    fs.renameSync(tmp, path.join(root, name));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Make `versionDir` current; the old current (if any, and different) becomes
 * `previous`. `current` is swapped LAST so a crash in between leaves the old
 * current serving.
 */
export function switchCurrent(root: string, versionDir: string): void {
  const old = pointerTarget(root, 'current');
  if (old && path.resolve(old) !== path.resolve(versionDir)) {
    atomicPoint(root, 'previous', old);
  }
  atomicPoint(root, 'current', versionDir);
}

/**
 * Roll back: `current` ← `previous` (and `previous` ← the version rolled away
 * from). Returns the version now current, or null when there is nothing to roll
 * back to (no previous, or it is no longer runnable).
 */
export function rollbackCurrent(root: string): string | null {
  const prev = pointerTarget(root, 'previous');
  const cur = pointerTarget(root, 'current');
  if (!prev || !entryOf(prev)) return null;
  if (cur && path.resolve(cur) !== path.resolve(prev)) atomicPoint(root, 'previous', cur);
  atomicPoint(root, 'current', prev);
  return versionOf(prev);
}

/** The version directory under `root` that `file` lives in, or null. */
export function versionDirContaining(root: string, file: string | undefined): string | null {
  if (!file) return null;
  let real: string;
  let realRoot: string;
  try {
    real = fs.realpathSync(file);
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  const rel = path.relative(realRoot, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const first = rel.split(path.sep)[0];
  return first && SEMVER_DIR.test(first) ? path.join(realRoot, first) : null;
}

/**
 * Garbage-collect: remove every version directory except `current`,
 * `previous` and the one the RUNNING process executes from (`runningEntry`,
 * normally `process.argv[1]`), plus abandoned staging directories. Never
 * throws; returns the removed directory names.
 */
export function gcVersions(root: string, runningEntry?: string): string[] {
  const keep = new Set<string>();
  for (const p of [
    pointerTarget(root, 'current'),
    pointerTarget(root, 'previous'),
    versionDirContaining(root, runningEntry),
  ]) {
    if (p) keep.add(path.basename(p));
  }
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    const isVersion = SEMVER_DIR.test(name);
    const isStaleStaging =
      name.startsWith('.staging-') && !name.includes(`-${process.pid}-`);
    if ((isVersion && !keep.has(name)) || isStaleStaging) {
      try {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
        removed.push(name);
      } catch {
        /* best-effort — retried on the next update */
      }
    }
  }
  return removed;
}

/**
 * The entry a process running `ownVersion` should hand over to, or null to keep
 * running itself: `current` must exist, be runnable and be STRICTLY newer.
 * (A newer global install — CLI_PREP below the backend's floor — therefore wins
 * over an older versioned one; the next self-update puts a fresh version on top.)
 */
export function redirectTarget(root: string, ownVersion: string | null): string | null {
  if (!ownVersion) return null;
  const cur = pointerTarget(root, 'current');
  if (!cur) return null;
  const v = versionOf(cur);
  const entry = entryOf(cur);
  if (!v || !entry) return null;
  return compareSemver(v, ownVersion) > 0 ? entry : null;
}
