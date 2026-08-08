import {
  isPackId,
  type PackActionPayload,
  type PackStartPayload,
} from '@codeam/shared';
import { log } from '../services/logger';
import { configureSkill } from '../skills/configure';
import type { AcpCommandContext, AcpCommandHandler } from '../agents/acp/command-handlers';
import {
  canonicalCommit,
  defaultCommandRunner,
  detectChecksCommand,
  diffStat,
  gitHead,
  runChecks,
} from './gates';
import { ensureLedgerIgnored, loadLatestRun, newRunId, saveRun, saveStageHandoff } from './run-store';
import { postPackState } from './events';
import { PackRunner, type PackRunnerDeps } from './runner';
import { getActivePackRunner, setActivePackRunner } from './active';

/**
 * Relay handlers for Agent Packs. `pack_start` validates, acks IMMEDIATELY
 * (a run can take hours — the relay must never wait on it), and detaches the
 * loop; `pack_action` mutates the live run; `pack_status` hydrates (falling
 * back to the workspace ledger after a CLI restart, where the run reports as
 * paused/stalled rather than pretending to still be live).
 */

const TERMINAL_STATUSES = new Set(['completed', 'aborted', 'failed']);

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
        const id = await ctx.client.newConversation();
        ctx.history.switchActiveSession(id);
        ctx.onActiveSessionChanged?.(id);
        return id;
      },
      runTurn: async (prompt, displayLine) => {
        await ctx.streaming.beginTurn();
        // The chat records a short stage line, not the full role brief —
        // the brief rides only the agent prompt (the onboarding precedent).
        ctx.history.appendUserPrompt(displayLine);
        await ctx.client.prompt(prompt);
        const text = ctx.streaming.getCurrentText();
        await ctx.streaming.closeTurnWithInteractiveDetection();
        ctx.history.appendAgentReply(text);
        await ctx.history.flush();
        return text;
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
    },
    gates: {
      head: () => gitHead(run, cwd),
      canonicalCommit: (sha) => canonicalCommit(run, cwd, sha),
      diffStat: (from, to) => diffStat(run, cwd, from, to),
      runChecks: async () => {
        const command = detectChecksCommand(cwd);
        return command ? runChecks(run, cwd, command) : null;
      },
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

export const packStartH: AcpCommandHandler = async (ctx) => {
  const payload = ctx.cmd.payload as Partial<PackStartPayload> | undefined;
  const packId = typeof payload?.packId === 'string' ? payload.packId : '';
  const task = typeof payload?.task === 'string' ? payload.task.trim() : '';
  if (!isPackId(packId)) {
    await ctx.relay.sendResult(ctx.cmd.id, 'failed', { error: `unknown pack: ${packId || '(none)'}` });
    return;
  }
  if (task.length === 0) {
    await ctx.relay.sendResult(ctx.cmd.id, 'failed', { error: 'pack_start requires a non-empty task' });
    return;
  }
  const existing = getActivePackRunner();
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
    await ctx.relay.sendResult(ctx.cmd.id, 'failed', { error: `unknown pack action: ${action || '(none)'}` });
    return;
  }
  const runner = getActivePackRunner();
  if (!runner) {
    await ctx.relay.sendResult(ctx.cmd.id, 'failed', {
      error: 'no active pack run in this session',
      state: loadLatestRun(ctx.opts.cwd),
    });
    return;
  }
  const state = await runner.applyAction(action as PackActionPayload['action']);
  await ctx.relay.sendResult(ctx.cmd.id, 'completed', { state });
};

export const packStatusH: AcpCommandHandler = async (ctx) => {
  const state = getActivePackRunner()?.getState() ?? loadLatestRun(ctx.opts.cwd);
  await ctx.relay.sendResult(ctx.cmd.id, 'completed', { state });
};
