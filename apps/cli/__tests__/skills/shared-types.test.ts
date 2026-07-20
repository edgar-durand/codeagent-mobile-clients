import { describe, it, expect } from 'vitest';
import type { SkillsManifest, SkillsManifestEntry, SkillId } from '@codeam/shared';

describe('skills wire types', () => {
  it('a manifest entry carries an id only (no content)', () => {
    const id: SkillId = 'code-review';
    const entry: SkillsManifestEntry = { id };
    const manifest: SkillsManifest = { skills: [entry] };
    expect(manifest.skills[0].id).toBe('code-review');
    // Entry must have no `body`/`delivery` keys — ids only, never content.
    expect(Object.keys(entry)).toEqual(['id']);
  });
});
