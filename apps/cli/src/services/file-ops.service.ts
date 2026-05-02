import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Read & write helpers for the mobile / landing mini-IDE modal. Resolves
 * paths relative to the CLI's working directory (i.e. the project the
 * user paired against), and refuses anything that escapes the cwd via
 * `..` so a malicious or buggy client can't pull /etc/passwd or write
 * outside the project.
 *
 * On the success path we return UTF-8 text. Binary files (images, etc.)
 * are rejected by a quick byte-prefix sniff — the modal is a code
 * editor; binary in a Monaco buffer would render as garbage and a
 * subsequent save would corrupt the file.
 */

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB — generous for code, blocks accidental binary blobs

function resolveSafe(rawPath: string): string {
  // Allow either an absolute path inside cwd or a relative path. Reject
  // anything that resolves outside the cwd.
  const cwd = process.cwd();
  const absolute = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(cwd, rawPath);
  const relativeFromCwd = path.relative(cwd, absolute);
  if (relativeFromCwd.startsWith('..') || path.isAbsolute(relativeFromCwd)) {
    throw new Error(`Path escapes the project root: ${rawPath}`);
  }
  return absolute;
}

function looksBinary(buf: Buffer): boolean {
  // Heuristic: a NUL byte in the first 8KB → binary.
  const sample = buf.subarray(0, Math.min(8192, buf.length));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

export async function readProjectFile(rawPath: string): Promise<{ content?: string; error?: string }> {
  try {
    const abs = resolveSafe(rawPath);
    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      return { error: 'Not a regular file.' };
    }
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
    const abs = resolveSafe(rawPath);
    if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_BYTES) {
      return { error: 'Content too large.' };
    }
    // Ensure the parent directory exists (mkdir -p), which lets the user
    // create a brand-new file in a brand-new folder via the modal.
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Write failed';
    return { error: msg };
  }
}
