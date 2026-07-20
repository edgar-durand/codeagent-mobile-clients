import { describe, it, expect } from 'vitest';
import {
  SKILL_REGISTRY,
  getSkillDefinition,
  isSkillId,
  skillHasRail,
} from '@codeam/shared';

describe('SKILL_REGISTRY', () => {
  it('every entry has an id-keyed self-consistent definition and ≥1 rail', () => {
    for (const [id, def] of Object.entries(SKILL_REGISTRY)) {
      expect(def.id).toBe(id);
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
      const rails = Object.keys(def.delivery);
      expect(rails.length).toBeGreaterThan(0);
    }
  });

  it('seeds code-review and resolve-conflicts with both rails', () => {
    for (const id of ['code-review', 'resolve-conflicts'] as const) {
      const def = SKILL_REGISTRY[id];
      expect(def.delivery.skillFile?.body.length).toBeGreaterThan(0);
      expect(def.delivery.instruction?.body.length).toBeGreaterThan(0);
    }
  });

  it('lookups + guards behave', () => {
    expect(isSkillId('code-review')).toBe(true);
    expect(isSkillId('nope')).toBe(false);
    expect(getSkillDefinition('code-review')?.name).toBe('Code Review');
    expect(getSkillDefinition('nope')).toBeNull();
    expect(skillHasRail('code-review', 'skillFile')).toBe(true);
  });
});
