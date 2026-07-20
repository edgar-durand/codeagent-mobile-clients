import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { readSkillsManifest, persistSkillsManifest, clearSkillsManifest, skillsManifestPath }
  from '../../src/skills/manifest';

describe('skills manifest', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('round-trips a manifest and clears it', () => {
    expect(readSkillsManifest()).toBeNull();
    persistSkillsManifest({ skills: [{ id: 'code-review' }] });
    expect(skillsManifestPath()).toContain('.codeam/skills.json');
    expect(readSkillsManifest()).toEqual({ skills: [{ id: 'code-review' }] });
    clearSkillsManifest();
    expect(readSkillsManifest()).toBeNull();
  });

  it('returns null on a malformed manifest', () => {
    fs.mkdirSync(path.dirname(skillsManifestPath()), { recursive: true });
    fs.writeFileSync(skillsManifestPath(), '{ not json');
    expect(readSkillsManifest()).toBeNull();
  });
});
