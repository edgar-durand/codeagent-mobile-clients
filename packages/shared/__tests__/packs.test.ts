import { describe, it, expect } from 'vitest';
import {
  PACK_REGISTRY,
  isPackId,
  getPackDefinition,
  PACK_WORKFLOW_ARTICLE,
  USER_EVENTS,
} from '../src';

describe('PACK_REGISTRY', () => {
  it('ships the two curated presets with the locked gates', () => {
    expect(PACK_REGISTRY['quick-pack'].gate).toBe('free');
    expect(PACK_REGISTRY['full-pack'].gate).toBe('pro');
    expect(PACK_REGISTRY['quick-pack'].stages.map((s) => s.role)).toEqual(['coder', 'reviewer']);
    expect(PACK_REGISTRY['full-pack'].stages.map((s) => s.role)).toEqual([
      'specifier',
      'coder',
      'reviewer',
      'qa',
    ]);
  });

  it('every stage carries a complete, self-sufficient brief', () => {
    for (const pack of Object.values(PACK_REGISTRY)) {
      expect(pack.name.length).toBeGreaterThan(0);
      expect(pack.tagline.length).toBeGreaterThan(0);
      for (const stage of pack.stages) {
        expect(stage.name.length).toBeGreaterThan(0);
        expect(stage.description.length).toBeGreaterThan(0);
        expect(stage.prompt).toContain(`# Role: ${stage.name}`);
        expect(stage.prompt.length).toBeGreaterThan(300);
        // Role keys double as the commit byline — no underscores/spaces (the
        // swarm-forge audit-filename rule, kept for our ledger filenames too).
        expect(stage.role).toMatch(/^[a-z][a-z0-9-]*$/);
      }
    }
  });

  it('the workflow article carries the handoff discipline', () => {
    expect(PACK_WORKFLOW_ARTICLE).toContain('By <role>.');
    expect(PACK_WORKFLOW_ARTICLE).toContain('.codeam/');
    expect(PACK_WORKFLOW_ARTICLE).toContain('Do not push');
  });

  it('isPackId / getPackDefinition guard unknown ids', () => {
    expect(isPackId('quick-pack')).toBe(true);
    expect(isPackId('mega-pack')).toBe(false);
    expect(getPackDefinition('full-pack')?.stages).toHaveLength(4);
    expect(getPackDefinition('nope')).toBeNull();
  });

  it('registers the pack_state user event', () => {
    expect(USER_EVENTS.PACK_STATE).toBe('pack_state');
  });
});
