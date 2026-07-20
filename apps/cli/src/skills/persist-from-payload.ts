// src/skills/persist-from-payload.ts
import type { SkillsManifestEntry } from '@codeam/shared';
import { persistSkillsManifest, clearSkillsManifest } from './manifest';

/** Self-hosted deploy: mirror the integrations pattern — write skills.json
 *  from the command payload before the pair-auto child spawns, or clear it
 *  when the deploy attached no skills. */
export function persistOrClearSkillsFromPayload(skills?: SkillsManifestEntry[]): void {
  if (skills && skills.length > 0) persistSkillsManifest({ skills });
  else clearSkillsManifest();
}
