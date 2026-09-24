import {
  PACK_FINDINGS_FILE,
  PACK_WORKFLOW_ARTICLE,
  extractHandoffSection,
  getPackDefinition,
  parsePackFindings,
  type PackActionKind,
  type PackDefinition,
  type PackHandoffRecord,
  type PackRunState,
  type PackStageDef,
  type PackStageState,
} from '@codeam/shared';

/**
 * The Agent Packs orchestrator — owns the sequential stage loop of one run.
 *
 * Pure control flow over injected seams (turn driver, git/gates, ledger,
 * state POST), so the whole pipeline is unit-testable without an agent:
 *
 *   for each stage: fresh conversation → role-primed turn → mechanical
 *   handoff capture (commit? diff? checks? findings?) → persist + post → next.
 *
 * Control surface (`pause/resume/retry/skip/abort`) takes effect at stage
 * BOUNDARIES — a mid-turn agent can't be safely yanked. A pause/abort asked
 * mid-turn is recorded as `pendingControl` (the UI says "after this stage")
 * instead of a false PAUSED; retry/skip are REJECTED while a stage is running
 * (they used to race the in-flight stage and overwrite its outcome).
 *
 * Two ways a stage continues:
 *   - FRESH (start, retry): new conversation, full role prompt.
 *   - IN PLACE (resume after the agent asked the user a question, or after a
 *     stall the user fixed in the stage chat): NO new prompt — the runner just
 *     re-checks the commit gate on the same conversation, nudging once there.
 *
 * One runner per session at a time. After a CLI restart the run is rebuilt
 * from the workspace ledger (`rehydrate`) with the interrupted stage marked
 * honestly, so the user's controls keep working instead of hitting a ghost.
 */

export interface PackTurnResult {
  /** The agent's final reply text for the turn. */
  text: string;
  /** The turn ended on a question for the user (a select prompt the app
   *  renders) — the stage is NOT done; nudging it would clobber the question. */
  awaitingUser: boolean;
  /**
   * The turn FAILED and this is the bubble the chat shows for it (a BYO
   * provider 402, an auth failure, the house ceiling, an adapter throw). The
   * stage fails immediately with this exact message — nudging a dead agent
   * for a commit only stalls on "no commit" and hides the cause (Agent Pack
   * run pk_mue0mxo3_96c730e6, 2026-09-23).
   */
  failure?: string;
}

export interface PackTurnDriver {
  /** Fresh ACP conversation for the next stage; returns its conversation id. */
  newConversation(): Promise<string>;
  /** Run ONE full turn: `prompt` goes to the agent; `displayLine` is what the
   *  chat history records as the user-side line (the full role brief would
   *  flood the chat). */
  runTurn(
    prompt: string,
    displayLine: string,
    /** Fires when a question for the user opens/closes MID-turn (a permission
     *  prompt), so the stage can say so instead of looking silently busy. */
    onAwaiting?: (pending: boolean) => void,
  ): Promise<PackTurnResult>;
  /** Best-effort cancel of the in-flight turn (abort path). */
  cancel(): Promise<void>;
  /** Mount a stage's curated skills (best-effort, Claude skillFile rail). */
  mountSkills(skillIds: string[]): void;
  /** Unmount the previous stage's skills so roles don't bleed into each other. */
  unmountSkills(skillIds: string[]): void;
}

export interface PackGateOps {
  head(): Promise<string | null>;
  canonicalCommit(sha: string): Promise<string | null>;
  diffStat(from: string, to: string): Promise<string>;
  /** Repo-relative paths changed between two commits. */
  changedFiles(from: string, to: string): Promise<string[]>;
  /** Run the project checks when a command is knowable; null = none available. */
  runChecks(): Promise<PackHandoffRecord['checks'] | null>;
  /** Read a repo-relative file from the working tree; null when absent. */
  readFile(relPath: string): Promise<string | null>;
}

export interface PackLedger {
  saveRun(state: PackRunState): void;
  saveStageHandoff(
    runId: string,
    stageIndex: number,
    role: string,
    handoff: PackHandoffRecord,
  ): void;
}

export interface PackRunnerDeps {
  driver: PackTurnDriver;
  gates: PackGateOps;
  ledger: PackLedger;
  /** Best-effort backend state POST (SSE republish + Redis snapshot). */
  postState(state: PackRunState): Promise<void>;
  log(message: string): void;
}

/** Outcome of a control action: the resulting state, plus why it was refused. */
export interface PackActionOutcome {
  state: PackRunState;
  rejected?: string;
}

export const TERMINAL_PACK_STATUSES: ReadonlySet<PackRunState['status']> = new Set([
  'completed',
  'aborted',
  'failed',
]);

const NUDGE_PROMPT =
  'Your stage is not committed yet. Commit your completed work now (focused commits, ' +
  'ending with your role byline `By <role>.` on its own line), then close with your `## Handoff` section and stop. ' +
  'If you are blocked, say exactly what is blocking you instead.';

const SUMMARY_TAIL_MAX_CHARS = 600;
const SUMMARY_SECTION_MAX_CHARS = 1500;
const EARLIER_HANDOFF_MAX_CHARS = 400;

// ─── Prompt composition ──────────────────────────────────────────────────────

export interface PriorStageOutcome {
  role: string;
  name: string;
  status: 'done' | 'skipped';
  handoff?: PackHandoffRecord;
}

export interface StagePromptContext {
  /** Canonical HEAD before the pipeline's first stage. */
  baseCommit?: string;
  /** Every earlier stage's outcome, in pipeline order. */
  prior: PriorStageOutcome[];
  /** 1 on the first attempt of this stage. */
  attempt: number;
  /** Why the previous attempt of this stage did not hand off (retry only). */
  previousAttemptError?: string;
}

export function composeStagePrompt(
  pack: PackDefinition,
  stageIndex: number,
  task: string,
  ctx: StagePromptContext,
): string {
  const stage = pack.stages[stageIndex];
  const pipeline = pack.stages
    .map((s, i) => (i === stageIndex ? `[${s.name}]` : s.name))
    .join(' → ');
  const position = [
    `${pack.name}: ${pipeline} — you are stage ${stageIndex + 1} of ${pack.stages.length}. Your commit byline: \`By ${stage.role}.\``,
  ];
  if (ctx.baseCommit) {
    position.push(
      `Pipeline base commit: \`${ctx.baseCommit}\` — everything the pipeline has done so far is \`git log ${ctx.baseCommit}..HEAD\` / \`git diff ${ctx.baseCommit}..HEAD\`. Use that range; do not guess it.`,
    );
  }
  const parts = [
    stage.prompt,
    PACK_WORKFLOW_ARTICLE,
    `## Your pipeline position\n${position.join('\n')}`,
    `## Task\n${task}`,
  ];

  const done = ctx.prior.filter((p) => p.status === 'done' && p.handoff);
  const skipped = ctx.prior.filter((p) => p.status === 'skipped');
  if (done.length > 0) {
    const last = done[done.length - 1];
    const earlier = done.slice(0, -1);
    if (earlier.length > 0) {
      parts.push(
        `## Earlier handoffs\n${earlier.map((p) => renderHandoff(p, EARLIER_HANDOFF_MAX_CHARS)).join('\n\n')}`,
      );
    }
    parts.push(
      `## Previous stage handoff (${last.role})\n${renderHandoff(last, SUMMARY_SECTION_MAX_CHARS)}`,
    );
  }
  if (skipped.length > 0) {
    parts.push(
      `## Skipped stages\n${skipped.map((p) => `- ${p.name} (${p.role}) was skipped by the user — its artifacts do not exist; do not assume them.`).join('\n')}`,
    );
  }
  if (ctx.attempt > 1) {
    parts.push(
      `## Previous attempt of this stage\nAttempt ${ctx.attempt - 1} did not hand off${ctx.previousAttemptError ? `: ${ctx.previousAttemptError}` : '.'}\nThe working tree may contain that attempt's partial work. Inspect it first, keep what is right, and finish the stage properly.`,
    );
  }
  return parts.join('\n\n');
}

function renderHandoff(p: PriorStageOutcome, summaryMax: number): string {
  const h = p.handoff as PackHandoffRecord;
  const head = [`### ${p.name} (${p.role})`, `commit: ${h.commit}`];
  if (h.diffStat) head.push(h.diffStat);
  if (h.checks)
    head.push(`checks (\`${h.checks.command}\`): ${h.checks.passed ? 'passed' : 'FAILED'}`);
  const lines = [head.join('\n')];
  const summary = h.summary.trim();
  if (summary) lines.push(summary.length > summaryMax ? `…${summary.slice(-summaryMax)}` : summary);
  if (h.checks && !h.checks.passed && h.checks.tail) {
    lines.push(`Checks output (tail):\n${h.checks.tail}`);
  }
  if (h.findings) {
    lines.push(renderFindings(h.findings, h.findingsNote));
  } else if (h.findingsNote) {
    lines.push(`Structured findings: ${h.findingsNote}`);
  }
  return lines.join('\n\n');
}

function renderFindings(findings: PackHandoffRecord['findings'], note?: string): string {
  const list = findings ?? [];
  const header = `Structured findings (${PACK_FINDINGS_FILE}): ${list.length}${note ? ` — ${note}` : ''}`;
  if (list.length === 0) return header;
  const rows = list.map((f) => {
    const where = f.file ? ` @ ${f.file}${f.line ? `:${f.line}` : ''}` : '';
    return `- [${f.id}] ${f.severity.toUpperCase()} — ${f.title}${where} → ${f.resolution}${f.commit ? ` (${f.commit})` : ''}`;
  });
  return `${header}\n${rows.join('\n')}`;
}

function summarizeReply(text: string): string {
  const section = extractHandoffSection(text);
  if (section)
    return section.length > SUMMARY_SECTION_MAX_CHARS
      ? section.slice(0, SUMMARY_SECTION_MAX_CHARS)
      : section;
  return text.trim().slice(-SUMMARY_TAIL_MAX_CHARS);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Two shas denote the same commit when one abbreviates the other. */
function sameCommit(a: string | null, b: string | null): boolean {
  if (!a || !b) return a === b;
  return a.startsWith(b) || b.startsWith(a);
}

// ─── The runner ──────────────────────────────────────────────────────────────

export class PackRunner {
  private readonly pack: PackDefinition;
  private state: PackRunState;
  private control: 'run' | 'pause' | 'abort' = 'run';
  private looping = false;
  private inTurn = false;
  /** Next `runStage` continues the current stage in place (no new prompt). */
  private resumeInPlace = false;
  private mountedSkills: string[] = [];

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

  /**
   * Rebuild a runner from the workspace ledger after a CLI restart. The
   * in-memory run died with the process; its conversation is gone. A stage
   * that was mid-turn is marked failed with the real reason (never left
   * "active" forever), and the run lands paused/stalled so Resume / Retry /
   * Skip / Abort all work again. Null when the pack id is unknown.
   */
  static rehydrate(deps: PackRunnerDeps, stored: PackRunState): PackRunner | null {
    const pack = getPackDefinition(stored.packId);
    if (!pack) return null;
    const interrupted = stored.stages.some((s) => s.status === 'active');
    const stages: PackStageState[] = stored.stages.map((s) =>
      s.status === 'active'
        ? {
            ...s,
            status: 'failed',
            error: 'the CLI restarted while this stage was running',
            conversationId: undefined,
            awaitingUser: undefined,
          }
        : s,
    );
    let status = stored.status;
    let stalledReason = stored.stalledReason;
    if (interrupted) {
      status = 'stalled';
      stalledReason =
        'The CLI restarted mid-stage. Resume re-checks whether the stage committed its work; Retry stage runs it again in a fresh conversation.';
    } else if (status === 'running') {
      status = 'paused';
      stalledReason = 'The CLI restarted between stages — tap Resume to continue.';
    }
    const state: PackRunState = {
      ...stored,
      stages,
      status,
      stalledReason,
      pendingControl: undefined,
    };
    return new PackRunner(deps, pack, state);
  }

  getState(): PackRunState {
    return this.state;
  }

  /** Persist + post the current state without changing it (rehydration announce). */
  async announce(): Promise<void> {
    await this.publish();
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
    this.state = { ...this.state, status, stalledReason, pendingControl: undefined };
    await this.publish();
  }

  private patchStage(index: number, patch: Partial<PackStageState>): void {
    const stages = this.state.stages.slice();
    stages[index] = { ...stages[index], ...patch };
    this.state = { ...this.state, stages };
  }

  // ── Control surface (relay `pack_action`) ────────────────────────────────

  async applyAction(action: PackActionKind): Promise<PackActionOutcome> {
    const status = this.state.status;
    const idx = this.state.currentStage;
    const reject = (why: string): PackActionOutcome => ({ state: this.state, rejected: why });

    if (TERMINAL_PACK_STATUSES.has(status)) return reject(`the run already finished (${status})`);

    switch (action) {
      case 'pause': {
        if (status === 'paused' || status === 'stalled') return { state: this.state };
        this.control = 'pause';
        // Mid-turn (or mid-gate) it takes effect at the boundary — say so
        // instead of flipping to a PAUSED the agent is visibly contradicting.
        this.state = { ...this.state, pendingControl: 'pause' };
        await this.publish();
        break;
      }
      case 'resume': {
        if (status !== 'paused' && status !== 'stalled')
          return reject(`nothing to resume — the run is ${status}`);
        this.control = 'run';
        const stage = this.state.stages[idx];
        // Resume = CONTINUE the current stage (the user answered its question
        // or fixed the blocker in its chat): re-check the commit gate, nudge
        // once in the same conversation when there still is one. Retry is the
        // fresh-conversation path.
        this.resumeInPlace = !!stage && (stage.awaitingUser === true || stage.status === 'failed');
        this.state = {
          ...this.state,
          status: 'running',
          stalledReason: undefined,
          pendingControl: undefined,
        };
        await this.publish();
        void this.run();
        break;
      }
      case 'retry_stage': {
        if (status === 'running' || this.inTurn)
          return reject('the stage is still running — pause or abort first');
        if (idx >= this.state.stages.length) return reject('no stage left to retry');
        const prev = this.state.stages[idx];
        // Keep attempts + error: the fresh prompt tells the role what went wrong.
        this.patchStage(idx, {
          status: 'pending',
          conversationId: undefined,
          handoff: undefined,
          awaitingUser: undefined,
          startCommit: undefined,
          attempts: prev.attempts,
          error: prev.error,
        });
        this.resumeInPlace = false;
        this.control = 'run';
        this.state = {
          ...this.state,
          status: 'running',
          stalledReason: undefined,
          pendingControl: undefined,
        };
        await this.publish();
        void this.run();
        break;
      }
      case 'skip_stage': {
        if (status === 'running' || this.inTurn)
          return reject('the stage is still running — pause or abort first');
        if (idx >= this.state.stages.length) return reject('no stage left to skip');
        this.patchStage(idx, { status: 'skipped', awaitingUser: undefined, error: undefined });
        this.resumeInPlace = false;
        this.control = 'run';
        this.state = {
          ...this.state,
          currentStage: idx + 1,
          status: 'running',
          stalledReason: undefined,
          pendingControl: undefined,
        };
        await this.publish();
        void this.run();
        break;
      }
      case 'abort': {
        this.control = 'abort';
        if (this.looping) {
          this.state = { ...this.state, pendingControl: 'abort' };
          await this.publish();
          await this.deps.driver.cancel().catch(() => undefined);
        } else {
          await this.settle('aborted');
        }
        break;
      }
    }
    return { state: this.state };
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
        if (!advanced) return; // stage stalled/paused/aborted — settled inside
      }
      await this.settle('completed');
      this.deps.log(`pack run ${this.state.runId} completed`);
    } catch (err) {
      // Belt: the loop must never throw into the void — settle honestly.
      await this.settle('failed', (err as Error).message).catch(() => undefined);
    } finally {
      this.looping = false;
      this.inTurn = false;
    }
  }

  /** Run one stage to its handoff. True = advanced; false = run settled. */
  private async runStage(index: number): Promise<boolean> {
    const stageDef = this.pack.stages[index];
    const inPlace = this.resumeInPlace;
    this.resumeInPlace = false;
    const startedMs = Date.now();

    try {
      let startSha: string | null;
      let turn: PackTurnResult;

      if (inPlace) {
        // The user drove the conversation (answered the question, or fixed
        // the blocker in the stage chat). No new prompt: straight to the gate.
        startSha = this.state.stages[index].startCommit ?? (await this.deps.gates.head());
        this.patchStage(index, { status: 'active', awaitingUser: undefined, error: undefined });
        this.state = { ...this.state, status: 'running' };
        await this.publish();
        turn = { text: '', awaitingUser: false };
      } else {
        startSha = await this.deps.gates.head();
        const prevStage = this.state.stages[index];
        const attempt = (prevStage.attempts ?? 0) + 1;
        const previousAttemptError = attempt > 1 ? prevStage.error : undefined;
        const startCommit = startSha ? await this.deps.gates.canonicalCommit(startSha) : null;
        this.patchStage(index, {
          status: 'active',
          attempts: attempt,
          startCommit: startCommit ?? undefined,
          conversationId: undefined,
          handoff: undefined,
          awaitingUser: undefined,
          error: undefined,
        });
        if (index === 0 && !this.state.baseCommit && startCommit) {
          this.state = { ...this.state, baseCommit: startCommit };
        }
        this.state = { ...this.state, status: 'running' };

        const conversationId = await this.deps.driver.newConversation();
        this.patchStage(index, { conversationId });
        await this.publish();

        this.swapSkills(stageDef.skillIds);

        const prompt = composeStagePrompt(this.pack, index, this.state.task, {
          baseCommit: this.state.baseCommit,
          prior: this.priorOutcomes(index),
          attempt,
          previousAttemptError,
        });
        const displayLine = `▶ ${this.pack.name} — stage ${index + 1}/${this.pack.stages.length}: ${stageDef.name}`;
        turn = await this.drive(prompt, displayLine, index);
      }

      if (this.aborted()) {
        await this.settle('aborted');
        return false;
      }
      if (turn.awaitingUser) return this.awaitUser(index);
      if (turn.failure) return this.stall(index, turn.failure); // the bubble IS the reply

      // A review-style stage (requiresCommit === false) legitimately approves
      // clean with NO change — treat a substantive no-commit reply as a
      // "reviewed, no changes" handoff against the commit it reviewed, rather
      // than nudging/stalling it for a commit that shouldn't exist.
      const commitOptional = stageDef.requiresCommit === false;
      let text = turn.text;
      let endSha = await this.deps.gates.head();

      if (!endSha || sameCommit(endSha, startSha)) {
        if (commitOptional && text.trim().length > 0) {
          return this.recordHandoff(
            index,
            stageDef,
            await this.noChangeHandoff(stageDef, startSha, text, startedMs),
          );
        }
        // ONE bounded nudge — then the run stalls honestly (never loop forever).
        // Only when there is a conversation to nudge in: after a CLI restart
        // the stage's conversation is gone, and a nudge would land on a fresh
        // agent with no idea what stage it is.
        if (!this.state.stages[index].conversationId) {
          return this.stall(
            index,
            'stage produced no commit — Retry stage to run it again in a fresh conversation',
          );
        }
        const nudged = await this.drive(NUDGE_PROMPT, '▶ Waiting for the stage commit…', index);
        if (this.aborted()) {
          await this.settle('aborted');
          return false;
        }
        if (nudged.awaitingUser) return this.awaitUser(index);
        if (nudged.failure) return this.stall(index, nudged.failure);
        text = nudged.text.trim().length > 0 ? nudged.text : text;
        endSha = await this.deps.gates.head();
        if (!endSha || sameCommit(endSha, startSha)) {
          // A commit-optional stage that STILL produced nothing meaningful is a
          // real stall (empty reply / crash), not a clean approval.
          if (commitOptional && text.trim().length > 0) {
            return this.recordHandoff(
              index,
              stageDef,
              await this.noChangeHandoff(stageDef, startSha, text, startedMs),
            );
          }
          return this.stall(index, 'stage produced no commit', text);
        }
      }

      const commit = await this.deps.gates.canonicalCommit(endSha);
      if (!commit) return this.stall(index, 'stage HEAD did not resolve to a commit', text);

      const handoff: PackHandoffRecord = {
        commit,
        summary: summarizeReply(text),
        diffStat: startSha ? await this.deps.gates.diffStat(startSha, endSha) : '',
        checks: (await this.deps.gates.runChecks()) ?? undefined,
        durationMs: Date.now() - startedMs,
      };
      if (stageDef.producesFindings) {
        Object.assign(handoff, await this.captureFindings(startSha, endSha));
      }
      return this.recordHandoff(index, stageDef, handoff);
    } catch (err) {
      if (this.aborted()) {
        await this.settle('aborted');
        return false;
      }
      return this.stall(index, (err as Error).message);
    }
  }

  /** Read through a method: `control` flips from another call while a turn is
   *  awaited, which TS's property narrowing would otherwise hide. */
  private aborted(): boolean {
    return this.control === 'abort';
  }

  private async drive(prompt: string, displayLine: string, index: number): Promise<PackTurnResult> {
    this.inTurn = true;
    try {
      return await this.deps.driver.runTurn(prompt, displayLine, (pending) => {
        // A permission prompt opened/closed mid-turn: the run keeps RUNNING
        // (the answer goes through the normal chat prompt and the turn resumes
        // by itself) but the stage says it is waiting on the user — live run
        // 2026-09-23: a guardrail confirm sat 5 min behind a "working" stage.
        this.patchStage(index, { awaitingUser: pending ? true : undefined });
        void this.publish();
      });
    } finally {
      this.inTurn = false;
    }
  }

  private swapSkills(next: string[]): void {
    const stale = this.mountedSkills.filter((id) => !next.includes(id));
    const fresh = next.filter((id) => !this.mountedSkills.includes(id));
    if (stale.length > 0) this.deps.driver.unmountSkills(stale);
    if (fresh.length > 0) this.deps.driver.mountSkills(fresh);
    this.mountedSkills = next.slice();
  }

  private async noChangeHandoff(
    stageDef: PackStageDef,
    startSha: string | null,
    text: string,
    startedMs: number,
  ): Promise<PackHandoffRecord> {
    const reviewedCommit = startSha ? await this.deps.gates.canonicalCommit(startSha) : null;
    return {
      commit: reviewedCommit ?? '(no changes)',
      summary: summarizeReply(text),
      diffStat: 'reviewed — no changes needed',
      durationMs: Date.now() - startedMs,
      // A findings-producing stage that hands off without a commit never
      // wrote its findings file (its contract says: commit it even when
      // empty). Say so — the next stage must not assume a clean bill.
      ...(stageDef.producesFindings
        ? {
            findingsNote: `no ${PACK_FINDINGS_FILE} committed — the stage handed off without structured findings`,
          }
        : {}),
    };
  }

  /**
   * Parse the stage's `PACK_FINDINGS_FILE` into the handoff. Only a file the
   * stage itself touched counts — a stale one left by an earlier run must not
   * masquerade as this review's verdict. Every failure path leaves an honest
   * `findingsNote`; none of them stalls the run.
   */
  private async captureFindings(
    startSha: string | null,
    endSha: string,
  ): Promise<Pick<PackHandoffRecord, 'findings' | 'findingsNote'>> {
    try {
      if (startSha) {
        const changed = await this.deps.gates.changedFiles(startSha, endSha);
        if (!changed.includes(PACK_FINDINGS_FILE)) {
          return {
            findingsNote: `${PACK_FINDINGS_FILE} was not written by this stage — no structured findings`,
          };
        }
      }
      const raw = await this.deps.gates.readFile(PACK_FINDINGS_FILE);
      if (raw === null)
        return { findingsNote: `no ${PACK_FINDINGS_FILE} — the stage left no structured findings` };
      const parsed = parsePackFindings(raw);
      if (!parsed.ok) return { findingsNote: `${PACK_FINDINGS_FILE}: ${parsed.error}` };
      const notes: string[] = [];
      if (parsed.value.findings.length === 0 && parsed.value.checked) {
        notes.push(`no findings; checked: ${parsed.value.checked.join(', ')}`);
      }
      if (parsed.value.note) notes.push(parsed.value.note);
      return {
        findings: parsed.value.findings,
        ...(notes.length > 0 ? { findingsNote: notes.join(' — ') } : {}),
      };
    } catch (err) {
      return { findingsNote: `could not read ${PACK_FINDINGS_FILE}: ${(err as Error).message}` };
    }
  }

  /** Mark a stage `done` with its handoff, persist, and advance. */
  private async recordHandoff(
    index: number,
    stageDef: PackStageDef,
    handoff: PackHandoffRecord,
  ): Promise<true> {
    this.patchStage(index, { status: 'done', handoff, awaitingUser: undefined, error: undefined });
    this.state = { ...this.state, currentStage: index + 1 };
    try {
      this.deps.ledger.saveStageHandoff(this.state.runId, index, stageDef.role, handoff);
    } catch (err) {
      this.deps.log(`pack handoff save failed: ${(err as Error).message}`);
    }
    await this.publish();
    return true;
  }

  /** The stage asked the user something: park the run, keep the conversation. */
  private async awaitUser(index: number): Promise<false> {
    const name = this.state.stages[index].name;
    this.patchStage(index, { awaitingUser: true });
    this.control = 'pause';
    await this.settle(
      'paused',
      `${name} asked you a question — answer it in the stage chat, then tap Resume.`,
    );
    this.deps.log(
      `pack run ${this.state.runId} paused at stage ${index + 1}: awaiting the user's answer`,
    );
    return false;
  }

  private async stall(index: number, reason: string, lastReply?: string): Promise<false> {
    this.patchStage(index, { status: 'failed', error: reason, awaitingUser: undefined });
    await this.settle(
      'stalled',
      lastReply ? `${reason} — last reply: ${lastReply.slice(-300)}` : reason,
    );
    this.deps.log(`pack run ${this.state.runId} stalled at stage ${index + 1}: ${reason}`);
    return false;
  }

  private priorOutcomes(index: number): PriorStageOutcome[] {
    const out: PriorStageOutcome[] = [];
    for (let i = 0; i < index; i++) {
      const s = this.state.stages[i];
      if (s.status === 'done' && s.handoff)
        out.push({ role: s.role, name: s.name, status: 'done', handoff: s.handoff });
      else if (s.status === 'skipped') out.push({ role: s.role, name: s.name, status: 'skipped' });
    }
    return out;
  }
}
