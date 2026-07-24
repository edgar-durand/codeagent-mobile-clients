import type { SkillDefinition } from './types';

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

export const resolveConflictsSkill: SkillDefinition = {
  id: 'resolve-conflicts',
  name: 'Resolve Conflicts',
  description: `Merge-conflict resolution that preserves both sides' intent, leaves no markers, and keeps the build green.`,
  source: 'curated',
  delivery: {
    skillFile: { body: RESOLVE_CONFLICTS_BODY },
    instruction: { body: RESOLVE_CONFLICTS_INSTRUCTION },
  },
};
