import type { PackDefinition, PackId } from './types';
import { SPECIFIER_PROMPT, CODER_PROMPT, REVIEWER_PROMPT, QA_PROMPT } from './roles';

/**
 * The curated pack registry — same model as SKILL_REGISTRY: bundled content
 * selected by id. Adding a pack = a stages list here + widening `PackId`.
 * Role prompts are shared building blocks (roles.ts); a pack is a pipeline
 * of roles. v1 ships two presets; the custom builder is a fast-follow.
 */
export const PACK_REGISTRY: Record<PackId, PackDefinition> = {
  'quick-pack': {
    id: 'quick-pack',
    name: 'Quick Pack',
    tagline: 'Implement, then a fresh-eyes review — the tight loop.',
    gate: 'free',
    stages: [
      {
        role: 'coder',
        name: 'Coder',
        description: 'Implements the task with tests, TDD-first.',
        skillIds: ['spec-driven-development'],
        prompt: CODER_PROMPT,
      },
      {
        role: 'reviewer',
        name: 'Reviewer',
        description: 'Skeptical review in a fresh context — finds and fixes what the coder missed.',
        skillIds: ['code-review', 'code-naming'],
        prompt: REVIEWER_PROMPT,
        // Review-only: approving clean with no change is success, not a stall.
        requiresCommit: false,
      },
    ],
  },
  'full-pack': {
    id: 'full-pack',
    name: 'Full Pack',
    tagline: 'Spec → implement → review → verify. Every quality gate, one run.',
    gate: 'pro',
    stages: [
      {
        role: 'specifier',
        name: 'Specifier',
        description: 'Turns the task into testable acceptance criteria before any code.',
        skillIds: ['spec-driven-development'],
        prompt: SPECIFIER_PROMPT,
      },
      {
        role: 'coder',
        name: 'Coder',
        description: 'Implements the acceptance criteria with tests, TDD-first.',
        skillIds: [],
        prompt: CODER_PROMPT,
      },
      {
        role: 'reviewer',
        name: 'Reviewer',
        description: 'Audits correctness, scope, design, and conventions with fresh eyes.',
        skillIds: ['code-review', 'code-naming'],
        prompt: REVIEWER_PROMPT,
        // Review-only: approving clean with no change is success, not a stall.
        requiresCommit: false,
      },
      {
        role: 'qa',
        name: 'QA',
        description: 'Verifies every acceptance criterion end to end and writes the final report.',
        skillIds: [],
        prompt: QA_PROMPT,
      },
    ],
  },
};

export function isPackId(id: string): id is PackId {
  return Object.prototype.hasOwnProperty.call(PACK_REGISTRY, id);
}

export function getPackDefinition(id: string): PackDefinition | null {
  return isPackId(id) ? PACK_REGISTRY[id] : null;
}
