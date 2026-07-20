// The single source of truth for curated Agent Skills. Adding one = 1 entry
// here (with its content). Because content is bundled and delivered as data,
// a new curated skill needs a client release but no backend logic.
import type { SkillDefinition, SkillId, SkillRail } from './types';

// --- code-review skill body (QUALITY playbook; the mechanical gh steps stay
// in buildAgentReviewPrompt — this skill is complementary reviewing guidance) ---
const CODE_REVIEW_BODY = `Use this skill when reviewing a pull request. It defines what a high-signal
review looks like so your inline comments are worth the author's time.

## Review priorities (in order)
1. **Correctness** — does the change do what the PR says, and only that? Trace the
   changed paths for logic errors, off-by-one, null/undefined, wrong branch, and
   inverted conditions. State a concrete failure scenario (inputs → wrong output)
   for anything you flag as a bug.
2. **Security** — untrusted input reaching a sink (SQL, shell, path, HTML), secrets
   in code/logs, authz gaps, credentials passed via argv instead of env.
3. **Tests** — does the change carry tests that would fail without it? Missing
   coverage on a bug-prone path is a finding.
4. **Clarity / reuse** — duplicated logic, a simpler existing helper, a name that
   misleads. Only raise these when they materially affect maintainability.

## Comment discipline
- One finding per comment, anchored to the exact line.
- Lead with severity: **blocker**, **should-fix**, or **nit**.
- Say WHY (the failure or risk), not just WHAT. Propose the fix when it is short.
- Do NOT restate the diff, praise trivially, or nitpick style a formatter owns.
- If the PR is correct and well-tested, say so plainly and approve — a clean review
  is a valid outcome, not a failure to find something.

## Scope
Review only what the diff changes and its direct blast radius. Do not demand
unrelated refactors.`;

const CODE_REVIEW_INSTRUCTION = `When reviewing this PR, prioritize correctness first, then security, then test
coverage, then clarity/reuse. One finding per inline comment, anchored to the exact
line, each led by a severity tag (blocker/should-fix/nit) and a concrete reason
(the failure scenario or risk), not a restatement of the diff. If the change is
correct and well-tested, approve and say so — finding nothing is a valid outcome.
Review only the diff and its direct blast radius; do not demand unrelated refactors.`;

// --- resolve-conflicts skill body ---
const RESOLVE_CONFLICTS_BODY = `Use this skill when resolving merge conflicts on a pull request. The goal is a
merge that preserves BOTH sides' intent, not one that just makes the file compile.

## Method
1. Understand each conflict hunk before editing: what did HEAD change, what did the
   base branch change, and WHY. Read the surrounding function, not just the markers.
2. Prefer a union of intents. Drop a side only when the two changes are genuinely
   mutually exclusive — and when you do, keep the side that matches the PR's purpose.
3. Never leave a conflict marker (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) behind. Grep for
   them before committing.
4. After resolving, the code must build and its tests must pass. Run them. A merge
   that resolves markers but breaks the build is not done.
5. For lockfiles/generated files, regenerate rather than hand-merge.

## Commit
One commit that explains what was reconciled and any intent you had to choose
between. Then push the branch.`;

const RESOLVE_CONFLICTS_INSTRUCTION = `When resolving these merge conflicts, preserve both sides' intent — read each hunk's
surrounding code to understand what HEAD and the base branch each changed and why,
and prefer a union of intents; drop a side only when the two are mutually exclusive,
keeping the side that matches the PR's purpose. Leave no conflict markers behind
(grep for them). Regenerate lockfiles rather than hand-merging them. The result must
build and pass tests — run them — before you commit and push.`;

export const SKILL_REGISTRY: Record<SkillId, SkillDefinition> = {
  'code-review': {
    id: 'code-review',
    name: 'Code Review',
    description: `High-signal PR review: prioritize correctness → security → tests → clarity, one anchored finding per comment.`,
    source: 'curated',
    delivery: {
      skillFile: { body: CODE_REVIEW_BODY },
      instruction: { body: CODE_REVIEW_INSTRUCTION },
    },
  },
  'resolve-conflicts': {
    id: 'resolve-conflicts',
    name: 'Resolve Conflicts',
    description: `Merge-conflict resolution that preserves both sides' intent, leaves no markers, and keeps the build green.`,
    source: 'curated',
    delivery: {
      skillFile: { body: RESOLVE_CONFLICTS_BODY },
      instruction: { body: RESOLVE_CONFLICTS_INSTRUCTION },
    },
  },
};

export function isSkillId(id: string): id is SkillId {
  return Object.prototype.hasOwnProperty.call(SKILL_REGISTRY, id);
}

export function getSkillDefinition(id: string): SkillDefinition | null {
  return isSkillId(id) ? SKILL_REGISTRY[id] : null;
}

export function skillHasRail(id: SkillId, rail: SkillRail): boolean {
  return Boolean(SKILL_REGISTRY[id].delivery[rail]);
}
