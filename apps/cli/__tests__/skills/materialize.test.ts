import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { materializeSkill, removeSkill, skillDirFor } from '../../src/skills/materialize';

describe('materializeSkill', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('writes a namespaced SKILL.md with frontmatter under ~/.claude/skills', () => {
    expect(materializeSkill('code-review', home)).toBe(true);
    const file = path.join(skillDirFor('code-review', home), 'SKILL.md');
    const md = fs.readFileSync(file, 'utf8');
    expect(skillDirFor('code-review', home)).toContain('.claude/skills/codeam-code-review');
    expect(md).toMatch(/^---\nname: code-review\ndescription: .+\n---\n/);
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
});
