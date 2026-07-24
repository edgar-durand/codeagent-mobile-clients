import type { SkillDefinition } from './types';

// QUALITY playbook; the mechanical gh steps stay in buildAgentReviewPrompt —
// this skill is complementary reviewing guidance.
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

export const codeReviewSkill: SkillDefinition = {
  id: 'code-review',
  name: 'Code Review',
  description: `High-signal PR review: prioritize correctness → security → tests → clarity, one anchored finding per comment.`,
  source: 'curated',
  delivery: {
    skillFile: { body: CODE_REVIEW_BODY },
    instruction: { body: CODE_REVIEW_INSTRUCTION },
  },
};
