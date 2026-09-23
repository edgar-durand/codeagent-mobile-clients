import { isPackId, type PackActionPayload, type PackStartPayload } from '@codeam/shared';
import { log } from '../services/logger';
import { configureSkill } from '../skills/configure';
import type { AcpCommandContext, AcpCommandHandler } from '../agents/acp/command-handlers';
import {
  canonicalCommit,
  changedFiles,
  defaultCommandRunner,
  detectChecksCommand,
  diffStat,
  gitHead,
  readWorkspaceFile,
  runChecks,
} from './gates';
import {
  ensureLedgerIgnored,
  loadLatestRun,
  newRunId,
  saveRun,
  saveStageHandoff,
} from './run-store';
import { postPackState } from './events';
import { PackRunner, TERMINAL_PACK_STATUSES, type PackRunnerDeps } from './runner';
import { getActivePackRunner, setActivePackRunner } from './active';

/**
 * Relay handlers for Agent Packs. `pack_start` validates, acks IMMEDIATELY
 * (a run can take hours — the relay must never wait on it), and detaches the
 * loop; `pack_action` mutates the live run; `pack_status` hydrates.
 *
 * After a CLI restart the in-memory runner is gone but the workspace ledger
 * is not: both `pack_action` and `pack_status` REHYDRATE a non-terminal run
 * from `run.json` (interrupted stage marked failed, run paused/stalled with
 * the reason) so the user's Resume / Retry / Skip / Abort keep working. Before
 * this, `pack_action` answered "no active pack run" and the backend sealed the
 * run as aborted — the spec's "resume at the stage boundary" never existed.
 */

const TERMINAL_STATUSES = TERMINAL_PACK_STATUSES;

const PACK_ACTIONS = new Set(['pause', 'resume', 'retry_stage', 'skip_stage', 'abort']);

/** Assemble real runner deps from the live ACP session context. */
export function buildPackRunnerDeps(ctx: AcpCommandContext): PackRunnerDeps {
  const cwd = ctx.opts.cwd;
  const run = defaultCommandRunner;
  return {
    driver: {
      newConversation: async () => {
        // The resume rail's exact switch: fresh conversation → re-point the
        // history anchor → re-point the runner's active id so later commands
        // (get_conversation, uploads) target the stage's conversation.
        // Managed sessions run auto-approve; a fresh conversation must re-assert
        // the agent's full-bypass mode or the stage's writes abort at the
        // permission layer (a fresh session/new doesn't inherit the initial
        // INITIAL_AGENT_MODE=agent-full-access env). Mirror the session posture.
        const id = await ctx.client.newConversation({
          ensureFullAutoMode: ctx.opts.autoApprovePermissions === true,
        });
        ctx.history.switchActiveSession(id);
        ctx.onActiveSessionChanged?.(id);
        return id;
      },
      runTurn: async (prompt, displayLine, onAwaiting) => {
        await ctx.streaming.beginTurn();
        // The chat records a short stage line, not the full role brief —
        // the brief rides only the agent prompt (the onboarding precedent).
        ctx.history.appendUserPrompt(displayLine);
        // Mid-turn permission prompts (a guardrail `confirm`, an interactive
        // tool approval) flip the stage to awaitingUser while they wait.
        ctx.streaming.setPendingListener(onAwaiting ?? null);
        try {
          await ctx.client.prompt(prompt);
          const text = ctx.streaming.getCurrentText();
          // True when the reply ended on a numbered-options question: the app
          // renders a select prompt and the user's pick re-prompts THIS
          // conversation. The runner must park the stage, not nudge over it.
          const awaitingUser = await ctx.streaming.closeTurnWithInteractiveDetection();
          ctx.history.appendAgentReply(text);
          await ctx.history.flush();
          return { text, awaitingUser };
        } finally {
          ctx.streaming.setPendingListener(null);
        }
      },
      cancel: () => ctx.client.cancel(),
      mountSkills: (skillIds) => {
        for (const id of skillIds) {
          try {
            configureSkill('add', id);
          } catch (err) {
            log.warn('packs', `skill mount failed for ${id}: ${(err as Error).message}`);
          }
        }
      },
      unmountSkills: (skillIds) => {
        for (const id of skillIds) {
          try {
            configureSkill('remove', id);
          } catch (err) {
            log.warn('packs', `skill unmount failed for ${id}: ${(err as Error).message}`);
          }
        }
      },
    },
    gates: {
      head: () => gitHead(run, cwd),
      canonicalCommit: (sha) => canonicalCommit(run, cwd, sha),
      diffStat: (from, to) => diffStat(run, cwd, from, to),
      changedFiles: (from, to) => changedFiles(run, cwd, from, to),
      runChecks: async () => {
        const command = detectChecksCommand(cwd);
        return command ? runChecks(run, cwd, command) : null;
      },
      readFile: async (relPath) => readWorkspaceFile(cwd, relPath),
    },
    ledger: {
      saveRun: (state) => saveRun(cwd, state),
      saveStageHandoff: (runId, index, role, handoff) =>
        saveStageHandoff(cwd, runId, index, role, handoff),
    },
    postState: (state) =>
      postPackState(
        {
          sessionId: ctx.opts.sessionId,
          pluginId: ctx.opts.pluginId,
          pluginAuthToken: ctx.opts.pluginAuthToken,
          pollSecret: ctx.opts.pollSecret,
        },
        state,
      ),
    log: (message) => log.info('packs', message),
  };
}

/**
 * The session's runner, rebuilt from the ledger when the process that owned
 * it is gone. Returns null when there is nothing live or resumable. A
 * rehydrated run is announced (ledger + backend) so the app stops showing a
 * stage that is "running" in a process that no longer exists.
 */
async function ensureRunner(ctx: AcpCommandContext): Promise<PackRunner | null> {
  const active = getActivePackRunner();
  if (active) return active;
  const stored = loadLatestRun(ctx.opts.cwd);
  if (!stored || TERMINAL_STATUSES.has(stored.status)) return null;
  const runner = PackRunner.rehydrate(buildPackRunnerDeps(ctx), stored);
  if (!runner) return null;
  setActivePackRunner(runner);
  log.info(
    'packs',
    `rehydrated run ${stored.runId} from the ledger (was ${stored.status}) → ${runner.getState().status}`,
  );
  await runner.announce();
  return runner;
}

export const packStartH: AcpCommandHandler = async (ctx) => {
  const payload = ctx.cmd.payload as Partial<PackStartPayload> | undefined;
  const packId = typeof payload?.packId === 'string' ? payload.packId : '';
  const task = typeof payload?.task === 'string' ? payload.task.trim() : '';
  if (!isPackId(packId)) {
    await ctx.relay.sendResult(ctx.cmd.id, 'failed', {
      error: `unknown pack: ${packId || '(none)'}`,
    });
    return;
  }
  if (task.length === 0) {
    await ctx.relay.sendResult(ctx.cmd.id, 'failed', {
      error: 'pack_start requires a non-empty task',
    });
    return;
  }
  const existing = await ensureRunner(ctx);
  if (existing && !TERMINAL_STATUSES.has(existing.getState().status)) {
    await ctx.relay.sendResult(ctx.cmd.id, 'failed', {
      error: 'a pack run is already active on this session — pause/abort it first',
      state: existing.getState(),
    });
    return;
  }

  ensureLedgerIgnored(ctx.opts.cwd);
  const runner = PackRunner.create(buildPackRunnerDeps(ctx), packId, task, newRunId());
  setActivePackRunner(runner);
  log.info('packs', `pack_start ${packId} run=${runner.getState().runId}`);
  // Ack BEFORE the loop — the run is long-lived; the command is "accepted".
  await ctx.relay.sendResult(ctx.cmd.id, 'completed', {
    accepted: true,
    runId: runner.getState().runId,
    state: runner.getState(),
  });
  void runner.run();
};

export const packActionH: AcpCommandHandler = async (ctx) => {
  const payload = ctx.cmd.payload as Partial<PackActionPayload> | undefined;
  const action = typeof payload?.action === 'string' ? payload.action : '';
  if (!PACK_ACTIONS.has(action)) {
    await ctx.relay.sendResult(ctx.cmd.id, 'failed', {
      error: `unknown pack action: ${action || '(none)'}`,
    });
    return;
  }
  const runner = await ensureRunner(ctx);
  if (!runner) {
    await ctx.relay.sendResult(ctx.cmd.id, 'failed', {
      error: 'no active pack run in this session',
      state: loadLatestRun(ctx.opts.cwd),
    });
    return;
  }
  const outcome = await runner.applyAction(action as PackActionPayload['action']);
  if (outcome.rejected) {
    log.info('packs', `pack_action ${action} rejected: ${outcome.rejected}`);
    await ctx.relay.sendResult(ctx.cmd.id, 'failed', {
      error: outcome.rejected,
      state: outcome.state,
    });
    return;
  }
  await ctx.relay.sendResult(ctx.cmd.id, 'completed', { state: outcome.state });
};

export const packStatusH: AcpCommandHandler = async (ctx) => {
  const runner = await ensureRunner(ctx);
  const state = runner?.getState() ?? loadLatestRun(ctx.opts.cwd);
  await ctx.relay.sendResult(ctx.cmd.id, 'completed', { state });
};
