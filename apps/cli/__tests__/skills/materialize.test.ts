import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { materializeSkill, removeSkill, skillDirFor } from '../../src/skills/materialize';
import { SKILL_REGISTRY, type SkillId } from '@codeam/shared';

/** Pull the `---\n...\n---` frontmatter block out of a rendered SKILL.md. */
function extractFrontmatter(md: string): string {
  const match = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error('no frontmatter block found');
  return match[1];
}

describe('materializeSkill', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('writes a namespaced SKILL.md with frontmatter under ~/.claude/skills', () => {
    expect(materializeSkill('code-review', home)).toBe(true);
    const file = path.join(skillDirFor('code-review', home), 'SKILL.md');
    const md = fs.readFileSync(file, 'utf8');
    expect(skillDirFor('code-review', home)).toContain('.claude/skills/codeam-code-review');
    expect(md).toMatch(/^---\nname: codeam-code-review\ndescription: .+\n---\n/);
    expect(md).toContain('Review priorities');
  });

  it('never writes into a repo .claude dir (only under home)', () => {
    materializeSkill('code-review', home);
    expect(skillDirFor('code-review', home).startsWith(home)).toBe(true);
  });

  it('removeSkill deletes the dir', () => {
    materializeSkill('code-review', home);
    removeSkill('code-review', home);
    expect(fs.existsSync(skillDirFor('code-review', home))).toBe(false);
  });

  it('returns false for an unknown skill', () => {
    // @ts-expect-error testing the guard
    expect(materializeSkill('nope', home)).toBe(false);
  });

  describe('frontmatter is valid YAML (the ": " colon-space bug)', () => {
    // `code-review`'s description contains ": " (colon-space), which is
    // illegal in an UNQUOTED YAML plain scalar and used to throw in Claude
    // Code's frontmatter parser, silently hiding the whole skill.
    // `resolve-conflicts`'s description contains an apostrophe — a good
    // second case for the round-trip since it needs no escaping itself but
    // must still survive being wrapped in double quotes.
    const ids: SkillId[] = ['code-review', 'resolve-conflicts'];

    it.each(ids)('%s: frontmatter block parses as YAML and round-trips the description', (id) => {
      expect(materializeSkill(id, home)).toBe(true);
      const md = fs.readFileSync(path.join(skillDirFor(id, home), 'SKILL.md'), 'utf8');
      const fm = extractFrontmatter(md);

      // Must not throw — this is exactly what failed before the fix for
      // `code-review` (unquoted ": " in the description broke the parser).
      let parsed: unknown;
      expect(() => { parsed = YAML.parse(fm); }).not.toThrow();

      const expectedDescription = SKILL_REGISTRY[id].description
        .replace(/\s*\n\s*/g, ' ')
        .trim();
      expect((parsed as { name: string; description: string }).name).toBe(`codeam-${id}`);
      expect((parsed as { name: string; description: string }).description).toBe(expectedDescription);
    });

    it('code-review: the raw frontmatter line is double-quoted (not emitted as a bare plain scalar)', () => {
      materializeSkill('code-review', home);
      const md = fs.readFileSync(path.join(skillDirFor('code-review', home), 'SKILL.md'), 'utf8');
      expect(md).toContain(`description: ${JSON.stringify(SKILL_REGISTRY['code-review'].description)}`);
    });
  });
});
