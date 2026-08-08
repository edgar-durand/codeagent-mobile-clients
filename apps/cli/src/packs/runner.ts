import {
  PACK_WORKFLOW_ARTICLE,
  getPackDefinition,
  type PackActionKind,
  type PackDefinition,
  type PackHandoffRecord,
  type PackRunState,
  type PackStageState,
} from '@codeam/shared';

/**
 * The Agent Packs orchestrator — owns the sequential stage loop of one run.
 *
 * Pure control flow over injected seams (turn driver, git/gates, ledger,
 * state POST), so the whole pipeline is unit-testable without an agent:
 *
 *   for each stage: fresh conversation → role-primed turn → mechanical
 *   handoff capture (commit? diff? checks?) → persist + post → next stage.
 *
 * Control surface (`pause/resume/retry/skip/abort`) takes effect at stage
 * BOUNDARIES (a mid-turn agent can't be safely yanked; abort additionally
 * cancels the in-flight turn best-effort). One runner per session at a time.
 */

export interface PackTurnDriver {
  /** Fresh ACP conversation for the next stage; returns its conversation id. */
  newConversation(): Promise<string>;
  /** Run ONE full turn: `prompt` goes to the agent; `displayLine` is what the
   *  chat history records as the user-side line (the full role brief would
   *  flood the chat). Resolves with the agent's final reply text. */
  runTurn(prompt: string, displayLine: string): Promise<string>;
  /** Best-effort cancel of the in-flight turn (abort path). */
  cancel(): Promise<void>;
  /** Mount a stage's curated skills (best-effort, Claude skillFile rail). */
  mountSkills(skillIds: string[]): void;
}

export interface PackGateOps {
  head(): Promise<string | null>;
  canonicalCommit(sha: string): Promise<string | null>;
  diffStat(from: string, to: string): Promise<string>;
  /** Run the project checks when a command is knowable; null = none available. */
  runChecks(): Promise<PackHandoffRecord['checks'] | null>;
}

export interface PackLedger {
  saveRun(state: PackRunState): void;
  saveStageHandoff(runId: string, stageIndex: number, role: string, handoff: PackHandoffRecord): void;
}

export interface PackRunnerDeps {
  driver: PackTurnDriver;
  gates: PackGateOps;
  ledger: PackLedger;
  /** Best-effort backend state POST (SSE republish + Redis snapshot). */
  postState(state: PackRunState): Promise<void>;
  log(message: string): void;
}

const NUDGE_PROMPT =
  'Your stage is not committed yet. Commit your completed work now (focused commits, ' +
  'ending with your role byline `By <role>.` on its own line), then summarize in 2-4 lines and stop. ' +
  'If you are blocked, say exactly what is blocking you instead.';

const SUMMARY_MAX_CHARS = 600;

export function composeStagePrompt(
  pack: PackDefinition,
  stageIndex: number,
  task: string,
  previous: { role: string; handoff: PackHandoffRecord } | null,
): string {
  const stage = pack.stages[stageIndex];
  const pipeline = pack.stages.map((s, i) => (i === stageIndex ? `[${s.name}]` : s.name)).join(' → ');
  const parts = [
    stage.prompt,
    PACK_WORKFLOW_ARTICLE,
    `## Your pipeline position\n${pack.name}: ${pipeline} — you are stage ${stageIndex + 1} of ${pack.stages.length}. Your commit byline: \`By ${stage.role}.\``,
    `## Task\n${task}`,
  ];
  if (previous) {
    parts.push(
      `## Previous stage handoff (${previous.role})\ncommit: ${previous.handoff.commit}\n${previous.handoff.diffStat}\n\n${previous.handoff.summary}`,
    );
  }
  return parts.join('\n\n');
}

function nowIso(): string {
  return new Date().toISOString();
}

export class PackRunner {
  private readonly pack: PackDefinition;
  private state: PackRunState;
  private control: 'run' | 'pause' | 'abort' = 'run';
  private looping = false;

  constructor(
    private readonly deps: PackRunnerDeps,
    pack: PackDefinition,
    initial: PackRunState,
  ) {
    this.pack = pack;
    this.state = initial;
  }

  static create(deps: PackRunnerDeps, packId: string, task: string, runId: string): PackRunner {
    const pack = getPackDefinition(packId);
    if (!pack) throw new Error(`unknown pack: ${packId}`);
    const stages: PackStageState[] = pack.stages.map((s) => ({
      role: s.role,
      name: s.name,
      status: 'pending',
    }));
    const state: PackRunState = {
      runId,
      packId: pack.id,
      task,
      status: 'running',
      currentStage: 0,
      stages,
      startedAt: nowIso(),
      updatedAt: nowIso(),
    };
    return new PackRunner(deps, pack, state);
  }

  getState(): PackRunState {
    return this.state;
  }

  /** Persist + post the current state (ledger first — it's the truth). */
  private async publish(): Promise<void> {
    this.state = { ...this.state, updatedAt: nowIso() };
    try {
      this.deps.ledger.saveRun(this.state);
    } catch (err) {
      this.deps.log(`pack ledger save failed: ${(err as Error).message}`);
    }
    await this.deps.postState(this.state);
  }

  private async settle(status: PackRunState['status'], stalledReason?: string): Promise<void> {
    this.state = { ...this.state, status, stalledReason };
    await this.publish();
  }

  // ── Control surface (relay `pack_action`) ────────────────────────────────

  async applyAction(action: PackActionKind): Promise<PackRunState> {
    switch (action) {
      case 'pause':
        this.control = 'pause';
        if (this.state.status === 'running') {
          // Takes effect at the next stage boundary; reflect intent now.
          this.state = { ...this.state, status: 'paused' };
          await this.publish();
        }
        break;
      case 'resume':
        this.control = 'run';
        if (this.state.status === 'paused' || this.state.status === 'stalled') {
          this.state = { ...this.state, status: 'running', stalledReason: undefined };
          await this.publish();
          void this.run();
        }
        break;
      case 'retry_stage': {
        const idx = this.state.currentStage;
        if (idx < this.state.stages.length) {
          const stages = this.state.stages.slice();
          stages[idx] = { role: stages[idx].role, name: stages[idx].name, status: 'pending' };
          this.control = 'run';
          this.state = { ...this.state, stages, status: 'running', stalledReason: undefined };
          await this.publish();
          void this.run();
        }
        break;
      }
      case 'skip_stage': {
        const idx = this.state.currentStage;
        if (idx < this.state.stages.length) {
          const stages = this.state.stages.slice();
          stages[idx] = { ...stages[idx], status: 'skipped' };
          this.control = 'run';
          this.state = {
            ...this.state,
            stages,
            currentStage: idx + 1,
            status: 'running',
            stalledReason: undefined,
          };
          await this.publish();
          void this.run();
        }
        break;
      }
      case 'abort':
        this.control = 'abort';
        await this.deps.driver.cancel().catch(() => undefined);
        if (!this.looping) await this.settle('aborted');
        break;
    }
    return this.state;
  }

  // ── The loop ──────────────────────────────────────────────────────────────

  async run(): Promise<void> {
    if (this.looping) return; // resume/retry re-entry while already looping
    this.looping = true;
    try {
      while (this.state.currentStage < this.state.stages.length) {
        if (this.control === 'abort') {
          await this.settle('aborted');
          return;
        }
        if (this.control === 'pause') {
          await this.settle('paused');
          return;
        }
        const advanced = await this.runStage(this.state.currentStage);
        if (!advanced) return; // stage stalled/failed — settled inside
      }
      await this.settle('completed');
      this.deps.log(`pack run ${this.state.runId} completed`);
    } catch (err) {
      // Belt: the loop must never throw into the void — settle honestly.
      await this.settle('failed', (err as Error).message).catch(() => undefined);
    } finally {
      this.looping = false;
    }
  }

  /** Run one stage to its handoff. True = advanced; false = run settled. */
  private async runStage(index: number): Promise<boolean> {
    const stageDef = this.pack.stages[index];
    const startedMs = Date.now();
    const startSha = await this.deps.gates.head();

    let stages = this.state.stages.slice();
    stages[index] = { ...stages[index], status: 'active' };
    this.state = { ...this.state, stages, status: 'running' };

    try {
      const conversationId = await this.deps.driver.newConversation();
      stages = this.state.stages.slice();
      stages[index] = { ...stages[index], conversationId };
      this.state = { ...this.state, stages };
      await this.publish();

      this.deps.driver.mountSkills(stageDef.skillIds);

      const previous = this.previousHandoff(index);
      const prompt = composeStagePrompt(this.pack, index, this.state.task, previous);
      const displayLine = `▶ ${this.pack.name} — stage ${index + 1}/${this.pack.stages.length}: ${stageDef.name}`;
      let reply = await this.deps.driver.runTurn(prompt, displayLine);

      if (this.control === 'abort') {
        await this.settle('aborted');
        return false;
      }

      let endSha = await this.deps.gates.head();
      if (!endSha || endSha === startSha) {
        // ONE bounded nudge — then the run stalls honestly (never loop forever).
        reply = await this.deps.driver.runTurn(NUDGE_PROMPT, '▶ Waiting for the stage commit…');
        endSha = await this.deps.gates.head();
        if (!endSha || endSha === startSha) {
          return this.stall(index, 'stage produced no commit', reply);
        }
      }

      const commit = await this.deps.gates.canonicalCommit(endSha);
      if (!commit) return this.stall(index, 'stage HEAD did not resolve to a commit', reply);

      const handoff: PackHandoffRecord = {
        commit,
        summary: reply.trim().slice(-SUMMARY_MAX_CHARS),
        diffStat: startSha ? await this.deps.gates.diffStat(startSha, endSha) : '',
        checks: (await this.deps.gates.runChecks()) ?? undefined,
        durationMs: Date.now() - startedMs,
      };

      stages = this.state.stages.slice();
      stages[index] = { ...stages[index], status: 'done', handoff };
      this.state = { ...this.state, stages, currentStage: index + 1 };
      try {
        this.deps.ledger.saveStageHandoff(this.state.runId, index, stageDef.role, handoff);
      } catch (err) {
        this.deps.log(`pack handoff save failed: ${(err as Error).message}`);
      }
      await this.publish();
      return true;
    } catch (err) {
      if (this.control === 'abort') {
        await this.settle('aborted');
        return false;
      }
      return this.stall(index, (err as Error).message);
    }
  }

  private async stall(index: number, reason: string, lastReply?: string): Promise<false> {
    const stages = this.state.stages.slice();
    stages[index] = { ...stages[index], status: 'failed', error: reason };
    this.state = { ...this.state, stages };
    await this.settle('stalled', lastReply ? `${reason} — last reply: ${lastReply.slice(-300)}` : reason);
    this.deps.log(`pack run ${this.state.runId} stalled at stage ${index + 1}: ${reason}`);
    return false;
  }

  private previousHandoff(index: number): { role: string; handoff: PackHandoffRecord } | null {
    for (let i = index - 1; i >= 0; i--) {
      const s = this.state.stages[i];
      if (s.status === 'done' && s.handoff) return { role: s.role, handoff: s.handoff };
    }
    return null;
  }
}
