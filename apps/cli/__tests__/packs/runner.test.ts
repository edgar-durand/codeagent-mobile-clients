import { describe, it, expect, vi } from 'vitest';
import type { PackHandoffRecord, PackRunState } from '@codeam/shared';
import { PackRunner, composeStagePrompt, type PackRunnerDeps } from '../../src/packs/runner';
import { PACK_REGISTRY } from '@codeam/shared';

/**
 * The pipeline loop, driven end-to-end with fakes: each fake turn "commits"
 * by advancing the fake HEAD, so the runner's mechanical capture (commit,
 * diff, checks) and the control surface are exercised exactly as in
 * production — no agent, no git.
 */

type TurnMode = 'commit' | 'no-commit' | 'throw' | 'ask';

interface FakeWorld {
  deps: PackRunnerDeps;
  turns: Array<{ prompt: string; displayLine: string }>;
  states: PackRunState[];
  setTurnBehavior(fn: (turnIndex: number) => TurnMode): void;
  /** Simulate the user (or the agent, after the user's answer) committing in the stage chat. */
  commitOutOfBand(): void;
  /** What the workspace `REVIEW-FINDINGS.pack.json` holds (null = absent). */
  setFindingsFile(contents: string | null): void;
  mounted: string[][];
  unmounted: string[][];
}

function fakeWorld(): FakeWorld {
  let head = 'a'.repeat(40);
  let convSeq = 0;
  let turnSeq = 0;
  let findingsFile: string | null = null;
  let findingsWrittenAt: string | null = null;
  const turns: Array<{ prompt: string; displayLine: string }> = [];
  const states: PackRunState[] = [];
  const mounted: string[][] = [];
  const unmounted: string[][] = [];
  let behavior: (turnIndex: number) => TurnMode = () => 'commit';
  const advanceHead = (tag: string) => {
    head = tag.padStart(2, '0') + head.slice(2);
  };

  const deps: PackRunnerDeps = {
    driver: {
      newConversation: async () => `conv-${++convSeq}`,
      runTurn: async (prompt, displayLine) => {
        const idx = turnSeq++;
        turns.push({ prompt, displayLine });
        const mode = behavior(idx);
        if (mode === 'throw') throw new Error('adapter exploded');
        if (mode === 'ask')
          return { text: 'Which database?\n1. Postgres\n2. SQLite', awaitingUser: true };
        if (mode === 'commit') {
          advanceHead(`${idx}`);
          // A commit while a findings file is staged = the stage wrote it.
          if (findingsFile !== null && findingsWrittenAt === null) findingsWrittenAt = head;
        }
        return {
          text: `stage reply ${idx}\n\n## Handoff\nhandoff of turn ${idx}`,
          awaitingUser: false,
        };
      },
      cancel: async () => undefined,
      mountSkills: (ids) => {
        mounted.push(ids);
      },
      unmountSkills: (ids) => {
        unmounted.push(ids);
      },
    },
    gates: {
      head: async () => head,
      canonicalCommit: async (sha) => sha.slice(0, 10),
      diffStat: async () => '3 files changed, 42 insertions(+)',
      changedFiles: async (_from, to) =>
        findingsWrittenAt !== null && to.startsWith(findingsWrittenAt.slice(0, 10))
          ? ['src/x.ts', 'REVIEW-FINDINGS.pack.json']
          : ['src/x.ts'],
      runChecks: async () => ({ command: 'npm test', passed: true, tail: 'all green' }),
      readFile: async (rel) => (rel === 'REVIEW-FINDINGS.pack.json' ? findingsFile : null),
    },
    ledger: { saveRun: vi.fn(), saveStageHandoff: vi.fn() },
    postState: async (state) => {
      states.push(structuredClone(state));
    },
    log: () => undefined,
  };
  return {
    deps,
    turns,
    states,
    mounted,
    unmounted,
    setTurnBehavior: (fn) => {
      behavior = fn;
    },
    commitOutOfBand: () => advanceHead('ob'),
    setFindingsFile: (contents) => {
      findingsFile = contents;
      findingsWrittenAt = null;
    },
  };
}

describe('PackRunner — the sequential pipeline', () => {
  it('runs a quick-pack to completion: fresh conversation + handoff per stage', async () => {
    const w = fakeWorld();
    const runner = PackRunner.create(w.deps, 'quick-pack', 'add a health endpoint', 'run-1');
    await runner.run();

    const final = runner.getState();
    expect(final.status).toBe('completed');
    expect(final.stages.map((s) => s.status)).toEqual(['done', 'done']);
    expect(final.stages[0].conversationId).toBe('conv-1');
    expect(final.stages[1].conversationId).toBe('conv-2');
    // Mechanical handoffs: git-derived commit + checks, never model-claimed.
    for (const s of final.stages) {
      expect(s.handoff?.commit).toHaveLength(10);
      expect(s.handoff?.checks?.passed).toBe(true);
    }
    expect(w.deps.ledger.saveStageHandoff).toHaveBeenCalledTimes(2);
    // Stage 2's prompt carries stage 1's handoff (the pipeline's actual input).
    expect(w.turns[1].prompt).toContain('Previous stage handoff (coder)');
  });

  it('nudges once when a stage forgets to commit, then proceeds after the nudge commit', async () => {
    const w = fakeWorld();
    // Turn 0 (coder) doesn't commit; the nudge (turn 1) commits; reviewer commits.
    w.setTurnBehavior((i) => (i === 0 ? 'no-commit' : 'commit'));
    const runner = PackRunner.create(w.deps, 'quick-pack', 't', 'run-2');
    await runner.run();
    expect(runner.getState().status).toBe('completed');
    expect(w.turns[1].displayLine).toContain('Waiting for the stage commit');
  });

  it('stalls honestly when the nudge also produces no commit', async () => {
    const w = fakeWorld();
    w.setTurnBehavior(() => 'no-commit');
    const runner = PackRunner.create(w.deps, 'quick-pack', 't', 'run-3');
    await runner.run();
    const s = runner.getState();
    expect(s.status).toBe('stalled');
    expect(s.stages[0].status).toBe('failed');
    expect(s.stalledReason).toContain('no commit');
  });

  it('a review-only stage that approves clean (no commit) is DONE, not a stall', async () => {
    const w = fakeWorld();
    // Coder (stage 0) commits; Reviewer (stage 1, requiresCommit:false) approves
    // clean with no commit — the pipeline must complete, not stall.
    w.setTurnBehavior((i) => (i === 0 ? 'commit' : 'no-commit'));
    const runner = PackRunner.create(w.deps, 'quick-pack', 't', 'run-clean-review');
    await runner.run();

    const s = runner.getState();
    expect(s.status).toBe('completed');
    expect(s.stages.map((x) => x.status)).toEqual(['done', 'done']);
    // The reviewer hands off against the commit it reviewed, no diff.
    expect(s.stages[1].handoff?.diffStat).toBe('reviewed — no changes needed');
    expect(s.stages[1].handoff?.commit).toHaveLength(10);
    // No nudge was needed for the clean approval (coder=turn0, reviewer=turn1 only).
    expect(w.turns).toHaveLength(2);
  });

  it('a thrown turn stalls the run with the real error', async () => {
    const w = fakeWorld();
    w.setTurnBehavior(() => 'throw');
    const runner = PackRunner.create(w.deps, 'quick-pack', 't', 'run-4');
    await runner.run();
    expect(runner.getState().status).toBe('stalled');
    expect(runner.getState().stalledReason).toContain('adapter exploded');
  });

  it('retry_stage re-runs the failed stage in a NEW fresh conversation', async () => {
    const w = fakeWorld();
    let failFirst = true;
    w.setTurnBehavior(() => {
      if (failFirst) {
        failFirst = false;
        return 'throw';
      }
      return 'commit';
    });
    const runner = PackRunner.create(w.deps, 'quick-pack', 't', 'run-5');
    await runner.run();
    expect(runner.getState().status).toBe('stalled');

    await runner.applyAction('retry_stage');
    // applyAction re-enters run() detached — wait for it to settle.
    await vi.waitFor(() => expect(runner.getState().status).toBe('completed'));
    // conv-1 (failed attempt) + conv-2 (retry) + conv-3 (reviewer).
    expect(runner.getState().stages[0].conversationId).toBe('conv-2');
  });

  it('skip_stage advances past the stalled stage', async () => {
    const w = fakeWorld();
    let first = true;
    w.setTurnBehavior(() => {
      if (first) {
        first = false;
        return 'no-commit';
      }
      return 'commit';
    });
    const runner = PackRunner.create(w.deps, 'quick-pack', 't', 'run-6');
    await runner.run(); // stalls at coder (nudge also counts as turn → still no-commit? no: only first is no-commit)
    // First turn no-commit → nudge (second turn) commits → completes normally.
    // Force a real stall instead:
    const w2 = fakeWorld();
    w2.setTurnBehavior((i) => (i <= 1 ? 'no-commit' : 'commit'));
    const runner2 = PackRunner.create(w2.deps, 'quick-pack', 't', 'run-6b');
    await runner2.run();
    expect(runner2.getState().status).toBe('stalled');
    await runner2.applyAction('skip_stage');
    await vi.waitFor(() => expect(runner2.getState().status).toBe('completed'));
    expect(runner2.getState().stages[0].status).toBe('skipped');
    expect(runner2.getState().stages[1].status).toBe('done');
  });

  it('pause settles at the stage boundary and resume finishes the run', async () => {
    const w = fakeWorld();
    const runner = PackRunner.create(w.deps, 'full-pack', 't', 'run-7');
    // Pause after the first stage completes: flip control from inside a turn.
    let paused = false;
    const origRunTurn = w.deps.driver.runTurn.bind(w.deps.driver);
    w.deps.driver.runTurn = async (p, d) => {
      const out = await origRunTurn(p, d);
      if (!paused) {
        paused = true;
        await runner.applyAction('pause');
      }
      return out;
    };
    await runner.run();
    expect(runner.getState().status).toBe('paused');
    expect(runner.getState().stages[0].status).toBe('done');
    expect(runner.getState().currentStage).toBe(1);

    await runner.applyAction('resume');
    await vi.waitFor(() => expect(runner.getState().status).toBe('completed'));
    expect(runner.getState().stages.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done']);
  });

  it('abort finalizes the run as aborted', async () => {
    const w = fakeWorld();
    const runner = PackRunner.create(w.deps, 'quick-pack', 't', 'run-8');
    w.deps.driver.runTurn = async () => {
      await runner.applyAction('abort');
      return { text: 'partial', awaitingUser: false };
    };
    await runner.run();
    expect(runner.getState().status).toBe('aborted');
  });

  it('publishes every transition to the backend (ledger first)', async () => {
    const w = fakeWorld();
    const runner = PackRunner.create(w.deps, 'quick-pack', 't', 'run-9');
    await runner.run();
    const statuses = w.states.map((s) => s.status);
    expect(statuses[statuses.length - 1]).toBe('completed');
    // At least: stage1 active, stage1 done, stage2 active, stage2 done, completed.
    expect(w.states.length).toBeGreaterThanOrEqual(5);
    expect(w.deps.ledger.saveRun).toHaveBeenCalled();
  });
});

describe('composeStagePrompt', () => {
  const pack = PACK_REGISTRY['full-pack'];
  const specHandoff: PackHandoffRecord = {
    commit: '1111111111',
    summary: 'wrote 4 criteria',
    diffStat: '1 file changed',
    durationMs: 500,
  };
  const coderHandoff: PackHandoffRecord = {
    commit: 'abcdef1234',
    summary: 'implemented the endpoint',
    diffStat: '2 files changed',
    checks: { command: 'npm test', passed: false, tail: 'FAIL src/x.test.ts' },
    durationMs: 1000,
  };

  it('assembles role brief + workflow article + position + base commit + task + handoff chain', () => {
    const prompt = composeStagePrompt(pack, 2, 'my task', {
      baseCommit: 'b453c0dead',
      prior: [
        { role: 'specifier', name: 'Specifier', status: 'done', handoff: specHandoff },
        { role: 'coder', name: 'Coder', status: 'done', handoff: coderHandoff },
      ],
      attempt: 1,
    });
    expect(prompt).toContain('# Role: Reviewer');
    expect(prompt).toContain('Pipeline rules');
    expect(prompt).toContain('stage 3 of 4');
    expect(prompt).toContain('By reviewer.');
    expect(prompt).toContain('my task');
    // The diff range is GIVEN, never guessed by the reviewer.
    expect(prompt).toContain('git diff b453c0dead..HEAD');
    // The immediate handoff in full, earlier ones summarized — QA sees the whole chain.
    expect(prompt).toContain('## Previous stage handoff (coder)');
    expect(prompt).toContain('abcdef1234');
    expect(prompt).toContain('## Earlier handoffs');
    expect(prompt).toContain('1111111111');
    // A failed checks verdict travels with its tail — the next role must not assume green.
    expect(prompt).toContain('checks (`npm test`): FAILED');
    expect(prompt).toContain('FAIL src/x.test.ts');
  });

  it('a retry names the previous attempt and its failure; a skipped stage is declared absent', () => {
    const prompt = composeStagePrompt(pack, 1, 'my task', {
      prior: [{ role: 'specifier', name: 'Specifier', status: 'skipped' }],
      attempt: 2,
      previousAttemptError: 'stage produced no commit',
    });
    expect(prompt).toContain('## Previous attempt of this stage');
    expect(prompt).toContain('Attempt 1 did not hand off: stage produced no commit');
    expect(prompt).toContain('Specifier (specifier) was skipped by the user');
  });

  it('renders structured findings as a checklist for the next stage', () => {
    const reviewerHandoff: PackHandoffRecord = {
      ...coderHandoff,
      findings: [
        {
          id: 'R1',
          severity: 'major',
          title: 'null deref on empty list',
          file: 'src/a.ts',
          line: 12,
          resolution: 'fixed',
          commit: 'abcdef1234',
        },
        { id: 'R2', severity: 'minor', title: 'name says what, not why', resolution: 'deferred' },
      ],
    };
    const prompt = composeStagePrompt(pack, 3, 'my task', {
      prior: [{ role: 'reviewer', name: 'Reviewer', status: 'done', handoff: reviewerHandoff }],
      attempt: 1,
    });
    expect(prompt).toContain('Structured findings (REVIEW-FINDINGS.pack.json): 2');
    expect(prompt).toContain(
      '- [R1] MAJOR — null deref on empty list @ src/a.ts:12 → fixed (abcdef1234)',
    );
    expect(prompt).toContain('- [R2] MINOR — name says what, not why → deferred');
  });
});

describe('PackRunner — hardening', () => {
  it('the handoff summary is the `## Handoff` section, not the reply tail', async () => {
    const w = fakeWorld();
    const runner = PackRunner.create(w.deps, 'quick-pack', 't', 'run-h1');
    await runner.run();
    expect(runner.getState().stages[0].handoff?.summary).toBe('handoff of turn 0');
  });

  it("records the pipeline base commit and each stage's start commit", async () => {
    const w = fakeWorld();
    const runner = PackRunner.create(w.deps, 'quick-pack', 't', 'run-h2');
    await runner.run();
    const s = runner.getState();
    expect(s.baseCommit).toBe('a'.repeat(10));
    expect(s.stages[0].startCommit).toBe('a'.repeat(10));
    expect(s.stages[1].startCommit).toBe(s.stages[0].handoff?.commit);
    expect(s.stages.map((x) => x.attempts)).toEqual([1, 1]);
    // Stage 2's prompt carries the base commit range.
    expect(w.turns[1].prompt).toContain(`git diff ${'a'.repeat(10)}..HEAD`);
  });

  it('a stage that asks the user a question PAUSES the run instead of nudging over the question', async () => {
    const w = fakeWorld();
    w.setTurnBehavior((i) => (i === 0 ? 'ask' : 'commit'));
    const runner = PackRunner.create(w.deps, 'quick-pack', 't', 'run-h3');
    await runner.run();
    const s = runner.getState();
    expect(s.status).toBe('paused');
    expect(s.stages[0].status).toBe('active');
    expect(s.stages[0].awaitingUser).toBe(true);
    expect(s.stalledReason).toContain('asked you a question');
    // No nudge was sent — the question is still the live turn.
    expect(w.turns).toHaveLength(1);
  });

  it('resume after the answer re-checks the gate IN PLACE: no new conversation, no new role prompt', async () => {
    const w = fakeWorld();
    w.setTurnBehavior((i) => (i === 0 ? 'ask' : 'commit'));
    const runner = PackRunner.create(w.deps, 'quick-pack', 't', 'run-h4');
    await runner.run();
    // The user answered in the stage chat and the agent committed there.
    w.commitOutOfBand();
    await runner.applyAction('resume');
    await vi.waitFor(() => expect(runner.getState().status).toBe('completed'));
    const s = runner.getState();
    expect(s.stages[0].conversationId).toBe('conv-1'); // same conversation kept
    expect(s.stages[0].awaitingUser).toBeUndefined();
    expect(s.stages[0].handoff?.commit).toHaveLength(10);
    // Turns: the question (0) + the reviewer (1). No re-prompt of the coder.
    expect(w.turns).toHaveLength(2);
    expect(w.turns[1].prompt).toContain('# Role: Reviewer');
  });

  it('resume after the answer with NO commit yet nudges once in the same conversation', async () => {
    const w = fakeWorld();
    w.setTurnBehavior((i) => (i === 0 ? 'ask' : 'commit'));
    const runner = PackRunner.create(w.deps, 'quick-pack', 't', 'run-h5');
    await runner.run();
    await runner.applyAction('resume');
    await vi.waitFor(() => expect(runner.getState().status).toBe('completed'));
    expect(w.turns[1].displayLine).toContain('Waiting for the stage commit');
    expect(runner.getState().stages[0].conversationId).toBe('conv-1');
  });

  it('retry_stage / skip_stage are REJECTED while a stage is running (no racing the in-flight stage)', async () => {
    const w = fakeWorld();
    let outcome: Awaited<ReturnType<PackRunner['applyAction']>> | null = null;
    const runner = PackRunner.create(w.deps, 'quick-pack', 't', 'run-h6');
    const origRunTurn = w.deps.driver.runTurn.bind(w.deps.driver);
    w.deps.driver.runTurn = async (p, d) => {
      if (!outcome) outcome = await runner.applyAction('skip_stage');
      return origRunTurn(p, d);
    };
    await runner.run();
    expect(outcome!.rejected).toMatch(/still running/);
    // The run finished normally: nothing was skipped.
    expect(runner.getState().status).toBe('completed');
    expect(runner.getState().stages.map((s) => s.status)).toEqual(['done', 'done']);
  });

  it('pause mid-turn is reported as PENDING (still running) until the stage boundary', async () => {
    const w = fakeWorld();
    const runner = PackRunner.create(w.deps, 'full-pack', 't', 'run-h7');
    let midTurnState: PackRunState | null = null;
    const origRunTurn = w.deps.driver.runTurn.bind(w.deps.driver);
    w.deps.driver.runTurn = async (p, d) => {
      if (!midTurnState) {
        await runner.applyAction('pause');
        midTurnState = structuredClone(runner.getState());
      }
      return origRunTurn(p, d);
    };
    await runner.run();
    expect(midTurnState!.status).toBe('running');
    expect(midTurnState!.pendingControl).toBe('pause');
    expect(runner.getState().status).toBe('paused');
    expect(runner.getState().pendingControl).toBeUndefined();
    expect(runner.getState().stages[0].status).toBe('done');
  });

  it('a retry tells the role what the previous attempt did wrong and counts attempts', async () => {
    const w = fakeWorld();
    w.setTurnBehavior((i) => (i <= 1 ? 'no-commit' : 'commit'));
    const runner = PackRunner.create(w.deps, 'quick-pack', 't', 'run-h8');
    await runner.run();
    expect(runner.getState().status).toBe('stalled');
    await runner.applyAction('retry_stage');
    await vi.waitFor(() => expect(runner.getState().status).toBe('completed'));
    expect(runner.getState().stages[0].attempts).toBe(2);
    expect(w.turns[2].prompt).toContain('Attempt 1 did not hand off: stage produced no commit');
  });

  it('actions on a finished run are rejected, not silently ignored', async () => {
    const w = fakeWorld();
    const runner = PackRunner.create(w.deps, 'quick-pack', 't', 'run-h9');
    await runner.run();
    const out = await runner.applyAction('resume');
    expect(out.rejected).toMatch(/already finished/);
  });

  it('swaps skills between stages instead of accumulating them', async () => {
    const w = fakeWorld();
    const runner = PackRunner.create(w.deps, 'quick-pack', 't', 'run-h10');
    await runner.run();
    expect(w.mounted).toEqual([['spec-driven-development'], ['code-review', 'code-naming']]);
    expect(w.unmounted).toEqual([['spec-driven-development']]);
  });

  it("parses the Reviewer's REVIEW-FINDINGS.pack.json into the handoff (only when the stage wrote it)", async () => {
    const w = fakeWorld();
    const runner = PackRunner.create(w.deps, 'quick-pack', 't', 'run-h11');
    // Coder runs first (turn 0); the findings file "appears" before the reviewer's commit.
    w.setTurnBehavior((i) => {
      if (i === 1) {
        w.setFindingsFile(
          JSON.stringify({
            findings: [
              {
                id: 'R1',
                severity: 'major',
                title: 'off-by-one in pagination',
                file: 'src/p.ts',
                line: 3,
                resolution: 'fixed',
                commit: 'abcdef1234',
              },
              { severity: 'weird', title: 'unlabeled entry is coerced, not dropped' },
              { nope: true },
            ],
          }),
        );
      }
      return 'commit';
    });
    await runner.run();
    const reviewer = runner.getState().stages[1];
    expect(reviewer.handoff?.findings).toHaveLength(2);
    expect(reviewer.handoff?.findings?.[0]).toMatchObject({
      id: 'R1',
      severity: 'major',
      resolution: 'fixed',
    });
    expect(reviewer.handoff?.findings?.[1]).toMatchObject({
      severity: 'major',
      resolution: 'needs_verification',
    });
    expect(reviewer.handoff?.findingsNote).toContain('1 malformed entry dropped');
    // The coder stage does not produce findings — nothing captured there.
    expect(runner.getState().stages[0].handoff?.findings).toBeUndefined();
  });

  it("a stale findings file the stage did not touch is NOT reported as this review's verdict", async () => {
    const w = fakeWorld();
    w.setFindingsFile(
      JSON.stringify({
        findings: [{ id: 'OLD', severity: 'nit', title: 'stale', resolution: 'fixed' }],
      }),
    );
    // Pretend the file pre-dates the run: mark it "written" before any turn.
    w.deps.gates.changedFiles = async () => ['src/x.ts'];
    const runner = PackRunner.create(w.deps, 'quick-pack', 't', 'run-h12');
    await runner.run();
    const reviewer = runner.getState().stages[1];
    expect(reviewer.handoff?.findings).toBeUndefined();
    expect(reviewer.handoff?.findingsNote).toContain('was not written by this stage');
  });

  it('a missing or malformed findings file never stalls the run', async () => {
    const w = fakeWorld();
    w.setTurnBehavior((i) => {
      if (i === 1) w.setFindingsFile('not json at all {{{');
      return 'commit';
    });
    const runner = PackRunner.create(w.deps, 'quick-pack', 't', 'run-h13');
    await runner.run();
    expect(runner.getState().status).toBe('completed');
    expect(runner.getState().stages[1].handoff?.findingsNote).toContain('not valid JSON');
  });
});

describe('PackRunner.rehydrate — after a CLI restart', () => {
  function storedMidStage(): PackRunState {
    const w = fakeWorld();
    const r = PackRunner.create(w.deps, 'quick-pack', 't', 'run-r1');
    const s = structuredClone(r.getState());
    s.stages[0] = {
      ...s.stages[0],
      status: 'done',
      handoff: { commit: '1234567890', summary: 'ok', diffStat: '', durationMs: 1 },
      attempts: 1,
    };
    // The stage began at the fake world's HEAD and nothing was committed before the crash.
    s.stages[1] = {
      ...s.stages[1],
      status: 'active',
      conversationId: 'conv-dead',
      attempts: 1,
      startCommit: 'a'.repeat(10),
    };
    s.currentStage = 1;
    s.baseCommit = 'a'.repeat(10);
    return s;
  }

  it('marks the interrupted stage failed with the real reason and lands the run stalled (never a ghost "running")', () => {
    const w = fakeWorld();
    const runner = PackRunner.rehydrate(w.deps, storedMidStage());
    expect(runner).not.toBeNull();
    const s = runner!.getState();
    expect(s.status).toBe('stalled');
    expect(s.stalledReason).toContain('CLI restarted');
    expect(s.stages[1].status).toBe('failed');
    expect(s.stages[1].error).toContain('CLI restarted');
    expect(s.stages[1].conversationId).toBeUndefined();
    expect(s.stages[0].status).toBe('done');
  });

  it('resume on a rehydrated stage checks the commit gate but does NOT nudge a conversation that no longer exists', async () => {
    const w = fakeWorld();
    const runner = PackRunner.rehydrate(w.deps, storedMidStage())!;
    await runner.applyAction('resume');
    await vi.waitFor(() => expect(runner.getState().status).toBe('stalled'));
    expect(w.turns).toHaveLength(0);
    expect(runner.getState().stalledReason).toContain('Retry stage');
  });

  it('resume on a rehydrated stage whose work WAS committed before the crash hands off and finishes', async () => {
    const w = fakeWorld();
    const stored = storedMidStage();
    const runner = PackRunner.rehydrate(w.deps, stored)!;
    w.commitOutOfBand(); // HEAD moved past the stage's startCommit
    await runner.applyAction('resume');
    await vi.waitFor(() => expect(runner.getState().status).toBe('completed'));
    expect(runner.getState().stages[1].handoff?.commit).toHaveLength(10);
  });

  it('retry on a rehydrated stage runs it fresh and completes the pipeline', async () => {
    const w = fakeWorld();
    const runner = PackRunner.rehydrate(w.deps, storedMidStage())!;
    await runner.applyAction('retry_stage');
    await vi.waitFor(() => expect(runner.getState().status).toBe('completed'));
    expect(runner.getState().stages[1].attempts).toBe(2);
    expect(runner.getState().stages[1].conversationId).toBe('conv-1');
  });

  it('a run persisted as running BETWEEN stages comes back paused with a resume hint', () => {
    const w = fakeWorld();
    const stored = storedMidStage();
    stored.stages[1] = { role: 'reviewer', name: 'Reviewer', status: 'pending' };
    const runner = PackRunner.rehydrate(w.deps, stored)!;
    expect(runner.getState().status).toBe('paused');
    expect(runner.getState().stalledReason).toContain('tap Resume');
  });
});
