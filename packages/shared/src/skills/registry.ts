// The registry assembles every curated Agent Skill from its own file into one
// lookup. Adding a skill = a new `<id>.ts` file (definition + content) + one import
// line here + widening `SkillId` in `types.ts`. Because content is bundled and
// delivered as data, a new curated skill needs a client release but no backend logic.
import type { SkillDefinition, SkillId, SkillRail } from './types';
import { codeReviewSkill } from './code-review';
import { resolveConflictsSkill } from './resolve-conflicts';
import { specDrivenDevelopmentSkill } from './spec-driven-development';

export const SKILL_REGISTRY: Record<SkillId, SkillDefinition> = {
  'code-review': codeReviewSkill,
  'resolve-conflicts': resolveConflictsSkill,
  'spec-driven-development': specDrivenDevelopmentSkill,
};

export function isSkillId(id: string): id is SkillId {
  return Object.prototype.hasOwnProperty.call(SKILL_REGISTRY, id);
}

export function getSkillDefinition(id: string): SkillDefinition | null {
  return isSkillId(id) ? SKILL_REGISTRY[id] : null;
}

export function skillHasRail(id: SkillId, rail: SkillRail): boolean {
  return Boolean(SKILL_REGISTRY[id].delivery[rail]);
}
