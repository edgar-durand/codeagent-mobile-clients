// On-demand skill attach/detach for a RUNNING session. Claude hot-reloads the
// skills dir, so `add` takes effect without a respawn. Env can't be mutated on
// a live child — files can — which is why the file rail is the on-demand path.
import os from 'node:os';
import { isSkillId, type SkillId } from '@codeam/shared';
import { materializeSkill, removeSkill } from './materialize';
import { readSkillsManifest, persistSkillsManifest } from './manifest';

export type SkillsConfigureAction = 'add' | 'remove' | 'list';
export interface SkillsConfigureResult {
  ok: boolean;
  installed: SkillId[];
  error?: string;
}

function currentInstalled(): SkillId[] {
  const m = readSkillsManifest();
  return (m?.skills ?? []).map((s) => s.id).filter(isSkillId);
}

export function configureSkill(
  action: SkillsConfigureAction,
  skillId?: string,
  home: string = os.homedir(),
): SkillsConfigureResult {
  if (action === 'list') return { ok: true, installed: currentInstalled() };

  if (!skillId || !isSkillId(skillId)) {
    return { ok: false, installed: currentInstalled(), error: `unknown skill: ${skillId ?? '(none)'}` };
  }

  const set = new Set<SkillId>(currentInstalled());
  if (action === 'add') {
    if (!materializeSkill(skillId, home)) {
      return { ok: false, installed: [...set], error: `skill ${skillId} has no skillFile rail` };
    }
    set.add(skillId);
  } else if (action === 'remove') {
    removeSkill(skillId, home);
    set.delete(skillId);
  } else {
    return { ok: false, installed: currentInstalled(), error: `unknown action: ${action}` };
  }
  const installed = [...set];
  persistSkillsManifest({ skills: installed.map((id) => ({ id })) });
  return { ok: true, installed };
}
