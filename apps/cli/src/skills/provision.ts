// src/skills/provision.ts
//
// Composition root for curated Agent Skills, called before agent spawn (twin
// of buildMcpServersForStart). Reads ~/.codeam/skills.json and materializes
// each skillFile skill under $HOME so Claude discovers it. Purely local file
// work — best-effort, NEVER blocks or throws into the spawn path.
import os from 'node:os';
import { isSkillId, type SkillId } from '@codeam/shared';
import { readSkillsManifest } from './manifest';
import { materializeSkill } from './materialize';
import { log } from '../services/logger';

export function provisionSkillsForStart(home: string = os.homedir()): { materialized: SkillId[] } {
  const materialized: SkillId[] = [];
  try {
    const manifest = readSkillsManifest();
    if (!manifest || manifest.skills.length === 0) return { materialized };
    for (const entry of manifest.skills) {
      if (!isSkillId(entry.id)) continue;
      if (materializeSkill(entry.id, home)) materialized.push(entry.id);
    }
    if (materialized.length) {
      log.info('skills', `materialized ${materialized.length} skill(s): ${materialized.join(', ')}`);
    }
  } catch (err) {
    log.warn('skills', `provisionSkillsForStart failed (best-effort): ${err instanceof Error ? err.message : String(err)}`);
  }
  return { materialized };
}
