import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Same FAKE_HOME seam as __tests__/integrations-provision.test.ts —
// readSkillsManifest() always reads `os.homedir()/.codeam/skills.json` with
// no override param, and os.homedir() on macOS can ignore $HOME, so mocking
// node:os is the reliable way to point the manifest reader at a throwaway
// home without touching the real ~/.codeam. `home` is also passed explicitly
// to provisionSkillsForStart() to control where materializeSkill writes.
const { FAKE_HOME } = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const p = require('node:path') as typeof import('node:path');
  return { FAKE_HOME: fs.mkdtempSync(p.join(os.tmpdir(), 'skills-provision-home-')) };
});
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, homedir: () => FAKE_HOME, default: { ...actual, homedir: () => FAKE_HOME } };
});

import { provisionSkillsForStart } from '../../src/skills/provision';
import { skillDirFor } from '../../src/skills/materialize';

describe('provisionSkillsForStart', () => {
  const home = FAKE_HOME;

  beforeEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('no-op with no manifest (never throws)', () => {
    expect(provisionSkillsForStart(home)).toEqual({ materialized: [] });
  });

  it('materializes every skillFile skill in the manifest', () => {
    // write manifest under this home
    fs.mkdirSync(path.join(home, '.codeam'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.codeam', 'skills.json'),
      JSON.stringify({ skills: [{ id: 'code-review' }] }),
    );
    const res = provisionSkillsForStart(home);
    expect(res.materialized).toEqual(['code-review']);
    expect(fs.existsSync(path.join(skillDirFor('code-review', home), 'SKILL.md'))).toBe(true);
  });
});
