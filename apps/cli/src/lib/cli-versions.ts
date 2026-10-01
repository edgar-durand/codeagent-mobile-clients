// src/lib/cli-versions.ts
//
// Versioned, side-by-side codeam-cli installs for the self-updating host-agent.
//
// WHY (codeagent-siec, 2026-10-01): the host-agent used to self-update with
// `npm install -g codeam-cli@latest`, rewriting the global package tree IN PLACE.
// A session child spawned while npm was mid-rewrite could load a half-written
// tree. Now every version gets its OWN directory and the switch is one rename:
//
//   ~/.codeam/cli/
//     <version>/node_modules/codeam-cli/dist/index.js   (npm install --prefix)
//     <version>/.bad          a release that crashed before the host was ready
//     <version>/.pids/<pid>   processes running from this version (GC guard)
//     current  -> <version>   (atomic: temp symlink + rename(2))
//     previous -> <version>   (rollback target)
//     .install.lock           O_EXCL — one installer at a time
//
// ONLY the host-agent uses this (`host/host-launch.ts`): it spawns sessions from
// `current` and relaunches itself onto `current`. Every other `codeam` command —
// a local user's `codeam start`, `pair`, MCP stdio servers — runs exactly the
// binary that was launched, as before. Windows keeps the legacy global install
// (`versionedModeSupported`): directory symlinks there need junctions + absolute
// paths and a different relaunch story, and no Windows host-agent ships today.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compareSemver } from './updateNotifier';

const CLI_PKG = 'codeam-cli';
const SEMVER_DIR = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
/** Versions kept by GC regardless of use, newest first (plus current/previous). */
export const GC_KEEP_NEWEST = 3;
/** A lock older than this is considered abandoned (installer killed mid-way). */
const LOCK_STALE_MS = 15 * 60_000;

export function versionedModeSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

/** Root of the versioned installs. `CODEAM_CLI_VERSIONS_DIR` overrides (tests). */
export function cliVersionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEAM_CLI_VERSIONS_DIR || path.join(os.homedir(), '.codeam', 'cli');
}

function packageDirOf(versionDir: string): string {
  return path.join(versionDir, 'node_modules', CLI_PKG);
}

interface PkgJson {
  version?: unknown;
  bin?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function readPkg(versionDir: string): PkgJson | null {
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(packageDirOf(versionDir), 'package.json'), 'utf8'),
    );
    return isRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** JS entry of the package under `versionDir` (its `bin`), or null if not runnable. */
export function entryOf(versionDir: string): string | null {
  const pkg = readPkg(versionDir);
  if (!pkg) return null;
  const bin = pkg.bin;
  const named = isRecord(bin) ? bin.codeam : undefined;
  const rel = typeof bin === 'string' ? bin : typeof named === 'string' ? named : 'dist/index.js';
  const entry = path.join(packageDirOf(versionDir), rel);
  return fs.existsSync(entry) ? entry : null;
}

/**
 * What to put on a command line to run the version under `versionDir`:
 * `node_modules/.bin/codeam` (so the process reads `… /codeam host-agent`, the
 * shape the backend's `pgrep -f 'codeam host-agent'` fallback matches), else the
 * package entry. Spawned as `node <launcher> …`, so the node binary is ours.
 */
export function launcherOf(versionDir: string): string | null {
  const entry = entryOf(versionDir);
  if (!entry) return null;
  const bin = path.join(versionDir, 'node_modules', '.bin', 'codeam');
  try {
    return fs.realpathSync(bin) === fs.realpathSync(entry) ? bin : entry;
  } catch {
    return entry;
  }
}

/** `package.json` version of the package installed under `versionDir`. */
export function versionOf(versionDir: string): string | null {
  const v = readPkg(versionDir)?.version;
  return typeof v === 'string' ? v : null;
}

/** A `.bad` marker older than this is ignored: a transient boot outage must not
 *  ban a release forever. */
export const BAD_MARKER_TTL_MS = 24 * 60 * 60_000;
/** Pre-ready failures further apart than this do not add up to "two in a row". */
export const PRE_READY_WINDOW_MS = 60 * 60_000;

export function isBad(versionDir: string, now: number = Date.now()): boolean {
  try {
    return now - fs.statSync(path.join(versionDir, '.bad')).mtimeMs < BAD_MARKER_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * Count a host-agent exit BEFORE ready for this version; returns the number of
 * such exits within PRE_READY_WINDOW_MS (the caller marks `.bad` at 2).
 */
export function recordPreReadyFailure(versionDir: string, now: number = Date.now()): number {
  const file = path.join(versionDir, '.prefail');
  let count = 0;
  try {
    const [n, at] = fs.readFileSync(file, 'utf8').trim().split(' ').map(Number);
    if (Number.isFinite(n) && Number.isFinite(at) && now - (at as number) < PRE_READY_WINDOW_MS) {
      count = n as number;
    }
  } catch {
    /* first failure */
  }
  count += 1;
  try {
    fs.writeFileSync(file, `${count} ${now}`);
  } catch {
    /* best-effort */
  }
  return count;
}

/** The host reached ready on this version: forget earlier pre-ready exits. */
export function clearPreReadyFailures(versionDir: string): void {
  fs.rmSync(path.join(versionDir, '.prefail'), { force: true });
}

/** Mark a release as bad: the resolver and the installer skip it from now on. */
export function markBad(versionDir: string, reason: string): void {
  try {
    fs.writeFileSync(path.join(versionDir, '.bad'), `${new Date().toISOString()} ${reason}\n`);
  } catch {
    /* best-effort */
  }
}

/** Absolute directory a pointer resolves to, or null. */
export function pointerTarget(root: string, name: 'current' | 'previous'): string | null {
  try {
    return fs.realpathSync(path.join(root, name));
  } catch {
    return null;
  }
}

/** Atomically point `root/<name>` at `targetDir` (temp symlink + rename). */
function atomicPoint(root: string, name: 'current' | 'previous', targetDir: string): void {
  const tmp = path.join(root, `.${name}.tmp-${process.pid}-${Date.now()}`);
  fs.symlinkSync(path.relative(root, targetDir), tmp, 'dir');
  try {
    fs.renameSync(tmp, path.join(root, name));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Make `versionDir` current; the old current becomes `previous`. */
export function switchCurrent(root: string, versionDir: string): void {
  const old = pointerTarget(root, 'current');
  if (old && path.resolve(old) !== path.resolve(versionDir)) atomicPoint(root, 'previous', old);
  atomicPoint(root, 'current', versionDir);
}

export interface ResolvedVersion {
  dir: string;
  version: string;
  entry: string;
}

/** `current`, if it exists, is runnable and is NOT marked bad. */
export function validCurrent(root: string): ResolvedVersion | null {
  const dir = pointerTarget(root, 'current');
  if (!dir || isBad(dir)) return null;
  const version = versionOf(dir);
  const entry = launcherOf(dir);
  return version && entry ? { dir, version, entry } : null;
}

/**
 * Roll back `current` to `previous` (runnable, not bad). Returns the version now
 * current, or null when there is nothing safe to roll back to.
 */
export function rollbackCurrent(root: string): string | null {
  const prev = pointerTarget(root, 'previous');
  if (!prev || isBad(prev) || !entryOf(prev)) return null;
  const cur = pointerTarget(root, 'current');
  if (cur && path.resolve(cur) !== path.resolve(prev)) atomicPoint(root, 'previous', cur);
  atomicPoint(root, 'current', prev);
  return versionOf(prev);
}

/**
 * The entry the HOST-AGENT should spawn sessions from / relaunch onto: the
 * valid `current` when it is at least `ownVersion`, else `fallback` (normally
 * `process.argv[1]`). Never downgrades below what is running (a newer global
 * install — the backend's below-floor reinstall — wins).
 */
export function hostEntry(
  root: string,
  ownVersion: string | null,
  fallback: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!versionedModeSupported(platform) || !ownVersion) return fallback;
  const cur = validCurrent(root);
  return cur && compareSemver(cur.version, ownVersion) >= 0 ? cur.entry : fallback;
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Pids recorded under `<versionDir>/.pids` that are still alive. */
export function livePids(versionDir: string): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(versionDir, '.pids'));
  } catch {
    return [];
  }
  return names.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0 && pidAlive(pid));
}

/**
 * Record that THIS process runs from a versioned install (no-op otherwise, so
 * a local user's `codeam` never touches ~/.codeam/cli). GC never deletes a
 * version with a live pid. Removed again on exit (best-effort; a stale file is
 * harmless — its pid is dead).
 */
export function registerRunningVersion(
  root: string = cliVersionsRoot(),
  entry: string | undefined = process.argv[1],
): void {
  const dir = versionDirContaining(root, entry);
  if (!dir) return;
  const file = path.join(dir, '.pids', String(process.pid));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    process.once('exit', () => fs.rmSync(file, { force: true }));
  } catch {
    /* best-effort */
  }
}

/**
 * GC: remove version directories that are NOT current, previous, among the
 * GC_KEEP_NEWEST newest, nor used by any live process. Never throws.
 */
export function gcVersions(root: string): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(root).filter((n) => SEMVER_DIR.test(n));
  } catch {
    return removed;
  }
  const keep = new Set<string>(
    [...names].sort((a, b) => compareSemver(b, a)).slice(0, GC_KEEP_NEWEST),
  );
  for (const p of [pointerTarget(root, 'current'), pointerTarget(root, 'previous')]) {
    if (p) keep.add(path.basename(p));
  }
  for (const name of names) {
    const dir = path.join(root, name);
    if (keep.has(name) || livePids(dir).length > 0) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch {
      /* best-effort — retried on the next update */
    }
  }
  return removed;
}

/**
 * Exclusive install lock (`O_EXCL`). Returns a release function, or null when
 * another live installer holds it. A lock whose owner is dead, or older than
 * LOCK_STALE_MS, is taken over.
 */
export function acquireInstallLock(root: string): (() => void) | null {
  const lock = path.join(root, '.install.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => fs.rmSync(lock, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      let stale = false;
      try {
        const owner = Number(fs.readFileSync(lock, 'utf8'));
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        stale = !Number.isInteger(owner) || !pidAlive(owner) || age > LOCK_STALE_MS;
      } catch {
        stale = true;
      }
      if (!stale) return null;
      fs.rmSync(lock, { force: true });
    }
  }
  return null;
}
