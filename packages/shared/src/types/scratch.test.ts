import { describe, expect, it } from 'vitest';
import { DEPLOY_CHOICE_ORDER, orderDeployChoices, SCRATCH_STARTER_PROMPTS, SCRATCH_ZIP_FREE_LIMIT_BYTES } from './scratch';
import { USER_EVENTS } from './events';

describe('scratch wire types', () => {
  it('scratch comes first by default and flips when GitHub is linked', () => {
    expect(DEPLOY_CHOICE_ORDER).toEqual(['scratch', 'github']);
    expect(orderDeployChoices(false)).toEqual(['scratch', 'github']);
    expect(orderDeployChoices(true)).toEqual(['github', 'scratch']);
  });
  it('every starter prompt ends by asking for the preview (except the "what can you do" one)', () => {
    expect(SCRATCH_STARTER_PROMPTS.length).toBe(4);
    expect(SCRATCH_STARTER_PROMPTS.filter((p) => /preview/i.test(p.prompt)).length).toBe(3);
  });
  it('FREE ZIP limit is 100 MB', () => expect(SCRATCH_ZIP_FREE_LIMIT_BYTES).toBe(100 * 1024 * 1024));
  it('events are registered', () => {
    expect(USER_EVENTS.SCRATCH_SAVE_OFFER).toBe('scratch_save_offer');
    expect(USER_EVENTS.SCRATCH_PROJECT_STATE).toBe('scratch_project_state');
  });
});
