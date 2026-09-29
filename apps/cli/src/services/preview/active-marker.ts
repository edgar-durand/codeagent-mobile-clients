import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PreviewDetection } from '@codeam/shared';

/**
 * "A preview was serving in this workspace" — written when a preview reaches
 * ready, removed on an explicit stop. A CodeAgent Box that idle-sleeps loses
 * its dev server + tunnel with the container; on the next `codeam start` in
 * this workspace the marker brings the preview back without the user tapping
 * Preview again (owner, 2026-09-29).
 *
 * Lives OUTSIDE the project (`~/.codeam/preview-active/<sha(cwd)>.json`): it
 * is machine state, and a scratch project's `.codeam/` is not gitignored — a
 * marker inside the tree would ride along on "Save to GitHub". Best-effort: a
 * missing or unreadable marker just means "nothing to restore".
 */
function markerPath(cwd: string, homeDir: string = os.homedir()): string {
  const key = createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
  return path.join(homeDir, '.codeam', 'preview-active', `${key}.json`);
}

export async function writeActivePreviewMarker(
  cwd: string,
  detection: PreviewDetection,
  homeDir?: string,
): Promise<void> {
  try {
    const file = markerPath(cwd, homeDir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ detection, at: new Date().toISOString() }, null, 2) + '\n',
      'utf8',
    );
  } catch {
    /* best-effort */
  }
}

export async function clearActivePreviewMarker(cwd: string, homeDir?: string): Promise<void> {
  await fs.rm(markerPath(cwd, homeDir), { force: true }).catch(() => undefined);
}

export async function readActivePreviewMarker(
  cwd: string,
  homeDir?: string,
): Promise<PreviewDetection | null> {
  try {
    const raw = await fs.readFile(markerPath(cwd, homeDir), 'utf8');
    const parsed = JSON.parse(raw) as { detection?: PreviewDetection };
    return parsed.detection && typeof parsed.detection.command === 'string'
      ? parsed.detection
      : null;
  } catch {
    return null;
  }
}
