// src/skills/manifest.ts
//
// Persistence for the curated Agent Skills manifest the CLI reads before
// every agent spawn: ~/.codeam/skills.json — the set of skillFile skills
// (ids only, never content) a deploy attached for this session. Write
// mechanics mirror src/integrations/manifest.ts byte-for-byte.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SkillsManifest } from '@codeam/shared';
import { log } from '../services/logger';
import { restrictToOwner } from '../lib/restrict-to-owner';

export function skillsManifestPath(): string {
  return path.join(os.homedir(), '.codeam', 'skills.json');
}

/** Best-effort read: missing file or invalid JSON/shape → null (skills off). */
export function readSkillsManifest(): SkillsManifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(skillsManifestPath(), 'utf8')) as SkillsManifest;
    if (!Array.isArray(raw?.skills)) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Persist the manifest atomically (write a temp file, then rename) so a
 * concurrent reader never sees a half-written file. Best-effort: a failure to
 * persist is logged and swallowed — it must NEVER break the deploy.
 */
export function persistSkillsManifest(m: SkillsManifest): void {
  try {
    const file = skillsManifestPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    restrictToOwner(file);
  } catch (err) {
    log.warn(
      'skills',
      `failed to persist skills manifest (best-effort): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Remove the manifest (e.g. a deploy with zero skill selections). Best-effort. */
export function clearSkillsManifest(): void {
  try {
    fs.rmSync(skillsManifestPath(), { force: true });
  } catch {
    // best-effort
  }
}
