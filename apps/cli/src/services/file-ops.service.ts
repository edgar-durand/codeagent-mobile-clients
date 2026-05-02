import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Read & write helpers for the mobile / landing mini-IDE modal.
 *
 * Path resolution is forgiving: the agent often emits a path that's
 * relative to *its* working directory (whatever subdir of the project
 * it was inspecting), but the CLI's `process.cwd()` may be a few
 * levels above that — common in monorepo / parent-of-many-repos
 * setups. We resolve in three passes:
 *
 *   1. Direct: `cwd + path` (the typical case when the agent and the
 *      CLI share a cwd).
 *   2. Suffix walk: recursively scan first-level subdirs, ignoring the
 *      usual noise (`node_modules`, `.git`, build outputs, native
 *      mobile dirs, …), and pick any file whose absolute path *ends
 *      with* the requested relative path. Capped at depth 6 and 5000
 *      visited dirs so the worst case doesn't tank a busy machine.
 *   3. Pick the shortest match — the file closest to the project root
 *      is almost always the canonical one when multiple workspaces
 *      mirror the same path.
 *
 * Sandbox: the resolved absolute path must live under `cwd` (the
 * relative-from-cwd check), so a malicious or buggy client can't pull
 * `/etc/passwd` or write outside the user's project tree.
 *
 * Binary files (NUL byte in the first 8 KB) are rejected on read; the
 * cap on both directions is 5 MB.
 */

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_WALK_DEPTH = 6;
const MAX_VISITED_DIRS = 5000;

const SUBDIR_IGNORE = new Set([
  'node_modules', '.git', '.next', '.expo', 'dist', 'build', 'out', '.cache',
  'coverage', '.turbo', '.parcel-cache', '.idea', '.vscode', '.vscode-test',
  'ios', 'android', // expo-managed native dirs are huge and rarely interesting
  '.gradle', '.cxx', '.intellijPlatform', '.kotlin',
  'tmp', 'target', 'venv', '.venv', '.mypy_cache', '.pytest_cache',
  '__pycache__',
]);

function isUnder(parent: string, candidate: string): boolean {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function isExistingFile(absPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(absPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

interface WalkContext {
  visited: number;
  matches: string[];
  cap: number; // stop adding matches once we've collected enough
}

async function walkForSuffix(
  dir: string,
  needleVariants: string[],
  depth: number,
  ctx: WalkContext,
): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return;
  if (ctx.visited > MAX_VISITED_DIRS) return;
  if (ctx.matches.length >= ctx.cap) return;
  ctx.visited++;

  let entries: import('fs').Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // Files first so we can short-circuit if a match drops in this dir.
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(dir, e.name);
    if (needleVariants.some((needle) => full.endsWith(needle))) {
      ctx.matches.push(full);
      if (ctx.matches.length >= ctx.cap) return;
    }
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (SUBDIR_IGNORE.has(e.name)) continue;
    if (e.name.startsWith('.') && SUBDIR_IGNORE.has(e.name)) continue;
    await walkForSuffix(path.join(dir, e.name), needleVariants, depth + 1, ctx);
    if (ctx.matches.length >= ctx.cap) return;
  }
}

async function findFile(rawPath: string): Promise<string | null> {
  const cwd = process.cwd();

  // Pass 1: absolute or cwd-relative direct hit.
  if (path.isAbsolute(rawPath)) {
    const abs = path.normalize(rawPath);
    if (isUnder(cwd, abs) && (await isExistingFile(abs))) return abs;
  }
  const direct = path.resolve(cwd, rawPath);
  if (isUnder(cwd, direct) && (await isExistingFile(direct))) return direct;

  // Pass 2: suffix walk. Try both `/normalized/path` and `\\normalized\\path`
  // so Windows-shaped paths still match on POSIX (rare but cheap to do).
  const normalized = path.normalize(rawPath).replace(/^[./\\]+/, '');
  const needles = [
    `${path.sep}${normalized}`,
    `/${normalized}`,
  ].filter((v, i, a) => a.indexOf(v) === i);

  const ctx: WalkContext = { visited: 0, matches: [], cap: 16 };
  await walkForSuffix(cwd, needles, 0, ctx);

  const candidates = ctx.matches.filter((c) => isUnder(cwd, c));
  if (candidates.length === 0) return null;

  // Pass 3: prefer the SHORTEST match (closest to root → most canonical).
  candidates.sort((a, b) => a.length - b.length);
  return candidates[0];
}

async function findWriteTarget(rawPath: string): Promise<string | null> {
  const found = await findFile(rawPath);
  if (found) return found;
  const cwd = process.cwd();
  const fallback = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(cwd, rawPath);
  if (!isUnder(cwd, fallback)) return null;
  return fallback;
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(8192, buf.length));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

export async function readProjectFile(rawPath: string): Promise<{ content?: string; error?: string }> {
  try {
    const abs = await findFile(rawPath);
    if (!abs) {
      return { error: `File not found in the project tree: ${rawPath}` };
    }
    const stat = await fs.stat(abs);
    if (stat.size > MAX_FILE_BYTES) {
      return { error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB > ${MAX_FILE_BYTES / 1024 / 1024} MB).` };
    }
    const buf = await fs.readFile(abs);
    if (looksBinary(buf)) {
      return { error: 'Binary file — refusing to open in a code editor.' };
    }
    return { content: buf.toString('utf-8') };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Read failed';
    return { error: msg };
  }
}

export async function writeProjectFile(
  rawPath: string,
  content: string,
): Promise<{ ok?: boolean; error?: string }> {
  try {
    const abs = await findWriteTarget(rawPath);
    if (!abs) {
      return { error: `Path escapes the project root: ${rawPath}` };
    }
    if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_BYTES) {
      return { error: 'Content too large.' };
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Write failed';
    return { error: msg };
  }
}
