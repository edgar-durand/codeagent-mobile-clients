import fs from 'node:fs/promises';
import path from 'node:path';
import type { PreviewDetection } from '@codeam/shared';

/**
 * `.codeam/preview-active.json` — "a preview was serving here". Written when a
 * preview reaches ready, removed on an explicit stop. A CodeAgent Box that
 * idle-sleeps loses its dev server + tunnel with the container; on the next
 * `codeam start` in this workspace the marker brings the preview back without
 * the user tapping Preview again (owner, 2026-09-29). Best-effort: a missing
 * or unreadable marker just means "nothing to restore".
 */
const MARKER = path.join('.codeam', 'preview-active.json');

export async function writeActivePreviewMarker(
  cwd: string,
  detection: PreviewDetection,
): Promise<void> {
  try {
    const file = path.join(cwd, MARKER);
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

export async function clearActivePreviewMarker(cwd: string): Promise<void> {
  await fs.rm(path.join(cwd, MARKER), { force: true }).catch(() => undefined);
}

export async function readActivePreviewMarker(cwd: string): Promise<PreviewDetection | null> {
  try {
    const raw = await fs.readFile(path.join(cwd, MARKER), 'utf8');
    const parsed = JSON.parse(raw) as { detection?: PreviewDetection };
    return parsed.detection && typeof parsed.detection.command === 'string'
      ? parsed.detection
      : null;
  } catch {
    return null;
  }
}
