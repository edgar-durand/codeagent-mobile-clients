import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { configureSkill } from '../../src/skills/configure';
import { skillDirFor } from '../../src/skills/materialize';

// `configureSkill`'s own file writes (materializeSkill/removeSkill/skillDirFor)
// respect the explicit `home` param, but `readSkillsManifest`/`persistSkillsManifest`
// (Task 8) are NOT parameterized — they always resolve `os.homedir()`. Mock it to
// the same tmp dir so the manifest and the skill dir stay in the same sandbox and
// tests never touch the real ~/.codeam/skills.json (mirrors manifest.test.ts).
describe('configureSkill', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('add materializes + records', () => {
    const r = configureSkill('add', 'code-review', home);
    expect(r.ok).toBe(true);
    expect(r.installed).toContain('code-review');
    expect(fs.existsSync(path.join(skillDirFor('code-review', home), 'SKILL.md'))).toBe(true);
  });
  it('remove deletes + de-records', () => {
    configureSkill('add', 'code-review', home);
    const r = configureSkill('remove', 'code-review', home);
    expect(r.installed).not.toContain('code-review');
    expect(fs.existsSync(skillDirFor('code-review', home))).toBe(false);
  });
  it('list reflects installed', () => {
    configureSkill('add', 'code-review', home);
    expect(configureSkill('list', undefined, home).installed).toEqual(['code-review']);
  });
  it('rejects an unknown skill id on add', () => {
    const r = configureSkill('add', 'nope', home);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown skill/i);
  });
});
