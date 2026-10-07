import { describe, expect, it } from 'vitest';
import { DEPLOY_CHOICE_ORDER, orderDeployChoices, SCRATCH_STARTER_PROMPTS, SCRATCH_ZIP_FREE_LIMIT_BYTES } from './scratch';
import { USER_EVENTS } from './events';

describe('scratch wire types', () => {
  it('scratch comes first by default and flips when GitHub is linked', () => {
    expect(DEPLOY_CHOICE_ORDER).toEqual(['scratch', 'github']);
    expect(orderDeployChoices(false)).toEqual(['scratch', 'github']);
    expect(orderDeployChoices(true)).toEqual(['github', 'scratch']);
  });
  it('every starter builds on its first turn and opens the preview (a FREE task is never spent on a question)', () => {
    expect(SCRATCH_STARTER_PROMPTS.length).toBe(4);
    for (const p of SCRATCH_STARTER_PROMPTS) {
      expect(p.prompt).toMatch(/\bbuild\b/i);
      expect(p.prompt).toMatch(/open the preview/i);
      // No "ask me … first" / "give me ideas" — those spend a turn without building.
      expect(p.prompt).not.toMatch(/\bask me\b|\bideas\b/i);
    }
  });
  it('FREE ZIP limit is 100 MB', () => expect(SCRATCH_ZIP_FREE_LIMIT_BYTES).toBe(100 * 1024 * 1024));
  it('events are registered', () => {
    expect(USER_EVENTS.SCRATCH_SAVE_OFFER).toBe('scratch_save_offer');
    expect(USER_EVENTS.SCRATCH_PROJECT_STATE).toBe('scratch_project_state');
  });
});
