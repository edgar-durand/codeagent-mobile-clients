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
function renderSkillMd(id: SkillId, name: string, description: string, body: string): string {
  // description is single-line by contract; collapse any stray newlines.
  const desc = description.replace(/\s*\n\s*/g, ' ').trim();
  return `---\nname: ${id}\ndescription: ${desc}\n---\n\n${body.trim()}\n`;
}

export function materializeSkill(id: SkillId, home: string = os.homedir()): boolean {
  const def = getSkillDefinition(id);
  if (!def?.delivery.skillFile) return false;
  try {
    const dir = skillDirFor(id, home);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      renderSkillMd(id, def.name, def.description, def.delivery.skillFile.body),
      { encoding: 'utf8', mode: 0o600 },
    );
    for (const [rel, contents] of Object.entries(def.delivery.skillFile.files ?? {})) {
      const target = path.join(dir, rel);
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
