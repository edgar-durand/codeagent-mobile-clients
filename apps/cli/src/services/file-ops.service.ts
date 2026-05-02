import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Read & write helpers for the mobile / landing mini-IDE modal. The agent
 * pairs against whatever `cwd` the CLI was launched from — that's usually
 * the project root, but in monorepo / parent-dir setups the agent may
 * mention paths that live in a sibling subdirectory. We:
 *
 *   1. Try the path relative to `cwd` first (the common case).
 *   2. If not there, scan first-level subdirectories of `cwd` for the
 *      same relative path. Lets the agent reference `apps/foo/bar.ts`
 *      from a parent dir that holds multiple sub-repos and still hit
 *      the right file.
 *   3. Path is always required to stay *under* `cwd` after resolution
 *      (the relative-from-cwd check) so a malicious client can't pull
 *      `/etc/passwd` or write outside the project tree.
 *
 * Binary files (NUL byte in the first 8 KB) are rejected on read so a
 * Monaco buffer can't render garbage; 5 MB cap on both directions.
 */

const MAX_FILE_BYTES = 5 * 1024 * 1024;

const SUBDIR_IGNORE = new Set([
  'node_modules', '.git', '.next', '.expo', 'dist', 'build', 'out', '.cache',
  'coverage', '.turbo', '.parcel-cache', '.idea', '.vscode',
  'ios', 'android', // expo-managed native dirs are huge and rarely interesting
]);

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') ? true : !SUBDIR_IGNORE.has(e.name))
      .filter((e) => e.isDirectory() && !SUBDIR_IGNORE.has(e.name))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function isUnder(parent: string, candidate: string): boolean {
  const rel = path.relative(parent, candidate);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Find an existing file matching `rawPath`. Tries cwd-relative first, then
 * each first-level subdirectory of cwd. Returns the first absolute path
 * that exists and is a regular file.
 */
async function findFile(rawPath: string): Promise<string | null> {
  const cwd = process.cwd();
  const candidates: string[] = [];

  if (path.isAbsolute(rawPath)) {
    candidates.push(path.normalize(rawPath));
  } else {
    candidates.push(path.resolve(cwd, rawPath));
    const subdirs = await listSubdirs(cwd);
    for (const sub of subdirs) {
      candidates.push(path.resolve(sub, rawPath));
    }
  }

  for (const cand of candidates) {
    if (!isUnder(cwd, cand)) continue;
    try {
      const stat = await fs.stat(cand);
      if (stat.isFile()) return cand;
    } catch {
      /* continue */
    }
  }
  return null;
}

/**
 * Like `findFile` but returns the resolution target for a *write*: the
 * existing file path if one is found, otherwise the cwd-relative resolution
 * (which may not exist yet — `writeProjectFile` will create it). Always
 * sandboxed under `cwd`.
 */
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
