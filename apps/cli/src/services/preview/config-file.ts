import fs from 'fs/promises';
import path from 'path';
import type { PreviewDetection } from '@codeagent/shared';

/**
 * Repo-local override for the agent-driven detection step. When a
 * `.codeam/preview.json` exists in the current working directory,
 * the CLI's `request_preview_detect` handler reads it and emits
 * `preview_detection_ready` directly — no headless agent invocation,
 * no LLM tokens spent, instant repeat-runs.
 *
 * The schema mirrors `PreviewDetection` exactly so the file can be
 * written by the CLI on user request (the mobile / web confirmation
 * sheet's "Remember for this project" toggle calls
 * `save_preview_config`, which routes through `writePreviewConfig`).
 */

const CONFIG_DIR = '.codeam';
const CONFIG_FILE = 'preview.json';

function configPath(cwd: string): string {
  return path.join(cwd, CONFIG_DIR, CONFIG_FILE);
}

const REQUIRED_FIELDS = [
  'framework',
  'command',
  'args',
  'port',
  'ready_pattern',
] as const;

/**
 * Read the override file. Returns `null` when the file doesn't
 * exist, is unreadable, or fails shape validation (i.e. a stale
 * file edited by hand that no longer matches the current
 * PreviewDetection contract).
 */
export async function readPreviewConfig(
  cwd: string,
): Promise<PreviewDetection | null> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath(cwd), 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) return null;
  }
  return obj as unknown as PreviewDetection;
}

/**
 * Write the override file under `.codeam/preview.json`, creating the
 * directory if it doesn't yet exist. Idempotent — subsequent calls
 * overwrite. The file is checked-in-friendly (pretty-printed JSON
 * with a trailing newline) so a team can commit the override and
 * skip the agent step for every dev on the project.
 */
export async function writePreviewConfig(
  cwd: string,
  detection: PreviewDetection,
): Promise<void> {
  const filePath = configPath(cwd);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(detection, null, 2) + '\n', 'utf-8');
}
