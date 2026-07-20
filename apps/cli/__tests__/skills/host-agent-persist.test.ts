import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { persistOrClearSkillsFromPayload } from '../../src/skills/persist-from-payload';
import { readSkillsManifest } from '../../src/skills/manifest';

describe('persistOrClearSkillsFromPayload', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('persists when payload has skills', () => {
    persistOrClearSkillsFromPayload([{ id: 'code-review' }]);
    expect(readSkillsManifest()).toEqual({ skills: [{ id: 'code-review' }] });
  });
  it('clears when payload has none', () => {
    persistOrClearSkillsFromPayload([{ id: 'code-review' }]);
    persistOrClearSkillsFromPayload(undefined);
    expect(readSkillsManifest()).toBeNull();
  });
});
