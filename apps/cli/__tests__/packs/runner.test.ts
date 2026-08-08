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

interface FakeWorld {
  deps: PackRunnerDeps;
  turns: Array<{ prompt: string; displayLine: string }>;
  states: PackRunState[];
  setTurnBehavior(fn: (turnIndex: number) => 'commit' | 'no-commit' | 'throw'): void;
}

function fakeWorld(): FakeWorld {
  let head = 'a'.repeat(40);
  let convSeq = 0;
  let turnSeq = 0;
  const turns: Array<{ prompt: string; displayLine: string }> = [];
  const states: PackRunState[] = [];
  let behavior: (turnIndex: number) => 'commit' | 'no-commit' | 'throw' = () => 'commit';

  const deps: PackRunnerDeps = {
    driver: {
      newConversation: async () => `conv-${++convSeq}`,
      runTurn: async (prompt, displayLine) => {
        const idx = turnSeq++;
        turns.push({ prompt, displayLine });
        const mode = behavior(idx);
        if (mode === 'throw') throw new Error('adapter exploded');
        if (mode === 'commit') {
          head = `${idx}`.padStart(2, '0') + head.slice(2);
        }
        return `stage reply ${idx}`;
      },
      cancel: async () => undefined,
      mountSkills: vi.fn(),
    },
    gates: {
      head: async () => head,
      canonicalCommit: async (sha) => sha.slice(0, 10),
      diffStat: async () => '3 files changed, 42 insertions(+)',
      runChecks: async () => ({ command: 'npm test', passed: true, tail: 'all green' }),
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
    setTurnBehavior: (fn) => {
      behavior = fn;
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
      return 'partial';
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
  it('assembles role brief + workflow article + position + task + previous handoff', () => {
    const pack = PACK_REGISTRY['full-pack'];
    const handoff: PackHandoffRecord = {
      commit: 'abcdef1234',
      summary: 'implemented the endpoint',
      diffStat: '2 files changed',
      durationMs: 1000,
    };
    const prompt = composeStagePrompt(pack, 2, 'my task', { role: 'coder', handoff });
    expect(prompt).toContain('# Role: Reviewer');
    expect(prompt).toContain('Pipeline rules');
    expect(prompt).toContain('stage 3 of 4');
    expect(prompt).toContain('By reviewer.');
    expect(prompt).toContain('my task');
    expect(prompt).toContain('abcdef1234');
  });
});
