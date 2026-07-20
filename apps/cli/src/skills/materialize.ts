// Materializes a curated skill's SKILL.md (+ files) under the box $HOME:
//   ~/.claude/skills/codeam-<id>/SKILL.md
// NEVER the cloned repo's .claude/ — a curated skill must not be committable
// into the PR under review. Claude Code discovers + hot-reloads this dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSkillDefinition, type SkillId } from '@codeam/shared';
import { log } from '../services/logger';

const NS = 'codeam-';

export function skillDirFor(id: SkillId, home: string = os.homedir()): string {
  return path.join(home, '.claude', 'skills', `${NS}${id}`);
}

/** Build the SKILL.md with generated frontmatter (name/description drive
 *  Claude's progressive-disclosure index; the body is the full skill). */
function renderSkillMd(id: SkillId, description: string, body: string): string {
  // description is single-line by contract; collapse any stray newlines.
  const desc = description.replace(/\s*\n\s*/g, ' ').trim();
  // Emit as a double-quoted YAML scalar: an unquoted (plain) scalar is
  // invalid YAML wherever the value contains ": " (colon-space), which the
  // code-review skill's description does. JSON.stringify produces a valid
  // YAML double-quoted string (same escaping rules) for any input.
  return `---\nname: ${NS}${id}\ndescription: ${JSON.stringify(desc)}\n---\n\n${body.trim()}\n`;
}

export function materializeSkill(id: SkillId, home: string = os.homedir()): boolean {
  const def = getSkillDefinition(id);
  if (!def?.delivery.skillFile) return false;
  try {
    const dir = skillDirFor(id, home);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      renderSkillMd(id, def.description, def.delivery.skillFile.body),
      { encoding: 'utf8', mode: 0o600 },
    );
    const baseDir = path.resolve(dir);
    const baseDirWithSep = baseDir + path.sep;
    for (const [rel, contents] of Object.entries(def.delivery.skillFile.files ?? {})) {
      const target = path.join(dir, rel);
      // Path containment guard: ensure target is inside dir
      if (!path.resolve(target).startsWith(baseDirWithSep) && path.resolve(target) !== baseDir) {
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, contents, { encoding: 'utf8', mode: 0o600 });
    }
    return true;
  } catch (err) {
    log.warn('skills', `failed to materialize ${id} (best-effort): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export function removeSkill(id: SkillId, home: string = os.homedir()): void {
  try {
    fs.rmSync(skillDirFor(id, home), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
