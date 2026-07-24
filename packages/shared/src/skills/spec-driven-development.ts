import type { SkillDefinition } from './types';

// An improved, adaptive take on spec-driven development: right-size the ceremony,
// ground in the real codebase, clarify without stalling, gate against
// over-engineering, and — the part most spec workflows lack — verify each
// acceptance criterion + adversarially self-review before calling it done. Tracks
// real work in beads, never scaffolds spec/plan/tasks files into the user's repo.
const SPEC_DRIVEN_BODY = `Use this skill for any coding task that isn't a trivial one-liner. Build the right
thing, provably, with the least ceremony the task warrants — specification before
code, but its depth scales to the work. Skipping it yields code that looks right yet
solves the wrong problem or breaks something you never checked.

## Step 0 — Right-size the work (always first)
- **Quick** — a typo, copy tweak, one-line fix, a single file with no unknowns.
  No ceremony: make the change, run the relevant test/build, confirm it. Do NOT
  write a spec for a typo.
- **Standard** — a feature or fix across a few files, some unknowns, a testable
  outcome. A light inline pass (a 2-3 sentence spec + a short plan), then build
  test-first, then verify. No scaffolding files.
- **Deep** — large, ambiguous, risky, or touching many files / shared contracts /
  data / auth. The full flow below, tracking the work in beads (\`bd\`), not scratch
  files.
When unsure, start one level lighter and escalate the moment real ambiguity or risk
appears. State which level you picked in one line.

## Step 1 — Ground in the real codebase (before specifying anything non-trivial)
You are almost never in a greenfield. Before you spec or plan, survey the real code:
the existing patterns for this kind of change, the files you'll touch, the test
setup, prior art, and the constraints (auth, data, shared types, CLAUDE.md
conventions). A spec written in a vacuum produces a plan that fights the codebase.
Read first; never assume.

## Step 2 — Specify: the WHAT and WHY (not the HOW)
State the user-visible outcome and why it matters, then the acceptance criteria —
each concrete and testable ("tapping X shows Y", "the endpoint returns 409 when Z"),
never vague ("works well"). List what is out of scope. Put NO implementation detail
here (no file names, no libraries). If a requirement is ambiguous, mark it rather
than guess.

## Step 3 — Clarify: resolve ambiguity, but don't stall
Gather the ambiguities that would actually change what you build. Ask the
highest-leverage ones — batched, at most ~3, phrased as concrete choices. For
low-stakes unknowns, pick a sensible default and SAY so ("assuming X unless you tell
me otherwise") instead of asking. On a conversational/mobile client every round-trip
is expensive — don't pester; decide what you safely can.

## Step 4 — Plan: the HOW, grounded and simple
Design against the real code. Apply the simplicity gates before committing:
- **Fewest moving parts** that satisfy the criteria. If you add a layer or
  abstraction, justify it or drop it.
- **Use the framework/library directly** — don't wrap it for flexibility you don't
  need yet.
- **Minimal blast radius** — touch what the change needs, nothing more.
State the test strategy (what proves each criterion) and name the real risks. Keep
the plan short.

## Step 5 — Tasks: small, verifiable, ordered
Split the plan into tasks that each end in something you can run and check. Mark
independent ones as parallelizable. Each task is the smallest unit worth its own
check. Sequence by dependency.

## Step 6 — Implement: test-first by default
For each task: write the test that would fail without the change, watch it fail, make
it pass, keep it green. Follow the patterns you found in Step 1. Commit in logical
units. Escape hatch: for a genuine spike or exploratory UI where test-first is
impractical, say so explicitly and add the test right after — never skip it silently.

## Step 7 — Verify + self-review (what separates "done" from "looks done")
Return to the acceptance criteria and prove EACH one is met — run the tests, diff the
behavior, look at the real output. Then review your own work adversarially:
- What did I NOT test?
- What did I change that I didn't need to?
- What could this have broken (the blast radius)?
- Does anything contradict the spec?
Fix what you find before declaring done. "The tests I wrote pass" is not "it works".

## Step 8 — Done + handoff
Done means acceptance criteria met, tests green, no known regressions. Summarize what
changed in plain terms. File any deferred work or follow-ups to beads (\`bd\`) so
nothing is lost. Never claim done on unverified work.

## Principles (the constitution)
- Clarify before you build; verify before you call it done.
- Testable beats descriptive — a criterion you can't check isn't one.
- Grounded beats greenfield — fit the codebase that exists.
- Simple beats clever — the least structure that works.
- Scale the process to the task — ceremony on a typo is a bug.
- Real work goes to beads, not throwaway files in someone's repo.`;

const SPEC_DRIVEN_INSTRUCTION = `Follow spec-driven development, scaled to the task:
1. Right-size first. A trivial change (typo, one file, no unknowns) → just make it
   well and verify, no ceremony. A feature/ambiguous/risky change → spec → plan →
   build → verify.
2. Ground in the real codebase before planning — read the existing patterns, tests,
   and constraints. Never assume; read first.
3. Specify the WHAT and WHY as testable acceptance criteria, not the HOW. Mark
   ambiguities instead of guessing.
4. Clarify only the highest-leverage unknowns (batch <=3, concrete choices); default
   the low-stakes ones and say so. Don't stall on round-trips.
5. Plan the simplest approach that fits the code: fewest moving parts, use libraries
   directly, minimal blast radius. State how each criterion will be tested.
6. Implement test-first by default; follow existing patterns; commit in logical units.
7. Verify EACH acceptance criterion (run tests, diff behavior), then self-review
   adversarially: what's untested? what did I change needlessly? what could I have
   broken? what contradicts the spec? Fix before declaring done.
8. Track deferred work in beads (bd), not scratch files. Simple beats clever; verify
   before done.`;

export const specDrivenDevelopmentSkill: SkillDefinition = {
  id: 'spec-driven-development',
  name: 'Spec-Driven Development',
  description: `Spec-driven development scaled to the task: right-size, ground in the code, write testable acceptance criteria, plan simply, build test-first, and verify every criterion before done.`,
  source: 'curated',
  delivery: {
    skillFile: { body: SPEC_DRIVEN_BODY },
    instruction: { body: SPEC_DRIVEN_INSTRUCTION },
  },
};
