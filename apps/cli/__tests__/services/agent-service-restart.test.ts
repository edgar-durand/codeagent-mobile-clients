import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentService } from '../../src/services/agent.service';
import type { IPtyStrategy } from '../../src/services/pty/types';
import type { RuntimeStrategy } from '../../src/agents/strategy';

/**
 * Covers `AgentService.restart()` — the `resume_session` teardown +
 * respawn + output-rewire path.
 *
 * The production bug ("switch conversation in history → nothing
 * works, not even new prompts"): Claude's initial spawn binds the
 * conversation via `--session-id <uuid>` (carried in
 * `initialLaunch.args`). `restart()` used to respawn with
 * `[...initialLaunch.args, ...resumeLaunchArgs]`, producing
 * `claude --session-id <uuid> --resume <id>`. Claude Code rejects
 * those two flags together and exits immediately, leaving the agent
 * dead — every subsequent prompt hits a corpse.
 *
 * The fix: when the runtime exposes `prepareResumeLaunch`, `restart()`
 * uses that COMPLETE launch (cmd + args, no `--session-id`) instead of
 * concatenating onto the original spawn args.
 */
describe('AgentService — restart / resume', () => {
  let strategy: IPtyStrategy;
  let killSpy: ReturnType<typeof vi.fn<() => void>>;
  let spawnSpy: ReturnType<typeof vi.fn<(cmd: string, cwd: string, args?: string[]) => void>>;
  let strategyOpts: { onData: (d: string) => void; onExit: (c: number) => void };

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.fn<() => void>();
    spawnSpy = vi.fn<(cmd: string, cwd: string, args?: string[]) => void>();
    strategy = {
      spawn: spawnSpy,
      write: vi.fn<(data: string | Buffer) => void>(),
      kill: killSpy,
      dispose: vi.fn<() => void>(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Build an AgentService wired to a runtime that mimics Claude:
   * the initial launch carries `--session-id <uuid>`, and the runtime
   * exposes `prepareResumeLaunch` returning a clean `--resume` launch.
   */
  function makeClaudeLikeAgent(): {
    agent: AgentService;
    initialArgs: string[];
  } {
    const initialArgs = ['--session-id', 'spawn-uuid'];
    const runtime = {
      meta: { id: 'claude', displayName: 'Claude Code' },
      resumeLaunchArgs: (id: string, opts?: { auto?: boolean }) =>
        opts?.auto ? ['--resume', id, '--dangerously-skip-permissions'] : ['--resume', id],
      prepareResumeLaunch: (id: string, opts?: { auto?: boolean }) => ({
        cmd: 'claude',
        args: opts?.auto
          ? ['--resume', id, '--dangerously-skip-permissions']
          : ['--resume', id],
      }),
    } as unknown as RuntimeStrategy;
    const agent = new AgentService(runtime, { cwd: '/tmp/test', onExit: vi.fn() });
    strategyOpts = (
      agent as unknown as {
        strategyOpts: { onData: (d: string) => void; onExit: (c: number) => void };
      }
    ).strategyOpts;
    // Simulate a live, ready session bound to the spawn-time launch.
    Object.assign(agent, {
      strategy,
      agentReady: true,
      initialLaunch: { cmd: 'claude', args: initialArgs, sessionId: 'spawn-uuid' },
    });
    return { agent, initialArgs };
  }

  test('respawn does NOT carry the spawn-time --session-id (the dead-agent bug)', () => {
    const { agent } = makeClaudeLikeAgent();
    agent.restart('resume-id', false);

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [, , args] = spawnSpy.mock.calls[0];
    expect(args).not.toContain('--session-id');
    expect(args).toContain('--resume');
    expect(args).toContain('resume-id');
  });

  test('auto=true respawn includes the permissions bypass, still no --session-id', () => {
    const { agent } = makeClaudeLikeAgent();
    agent.restart('resume-id', true);

    const [, , args] = spawnSpy.mock.calls[0];
    expect(args).not.toContain('--session-id');
    expect(args).toEqual(
      expect.arrayContaining(['--resume', 'resume-id', '--dangerously-skip-permissions']),
    );
  });

  test('after restart, output from the respawned PTY still streams to onData', () => {
    const onData = vi.fn();
    const initialArgs = ['--session-id', 'spawn-uuid'];
    const runtime = {
      meta: { id: 'claude', displayName: 'Claude Code' },
      resumeLaunchArgs: (id: string) => ['--resume', id],
      prepareResumeLaunch: (id: string) => ({ cmd: 'claude', args: ['--resume', id] }),
    } as unknown as RuntimeStrategy;
    const agent = new AgentService(runtime, { cwd: '/tmp/test', onData, onExit: vi.fn() });
    const opts = (
      agent as unknown as {
        strategyOpts: { onData: (d: string) => void; onExit: (c: number) => void };
      }
    ).strategyOpts;
    Object.assign(agent, {
      strategy,
      agentReady: true,
      initialLaunch: { cmd: 'claude', args: initialArgs, sessionId: 'spawn-uuid' },
    });

    agent.restart('resume-id', false);
    // The strategy's onData callback is bound once at construction and
    // re-used across respawns — a byte from the resumed process must
    // still reach the OutputService.
    opts.onData('hello from resumed session');
    expect(onData).toHaveBeenCalledWith('hello from resumed session');
  });

  test('a new prompt after restart is submitted (agent not wedged busy)', () => {
    const { agent } = makeClaudeLikeAgent();
    // Leave the agent in a "busy" state as if a turn had been running
    // when the user switched conversations.
    Object.assign(agent, { agentBusy: true });

    agent.restart('resume-id', false);

    const writeSpy = strategy.write as ReturnType<typeof vi.fn>;
    writeSpy.mockClear();
    agent.sendCommand('new prompt after resume');
    // The prompt must reach the freshly-spawned PTY — not sit queued
    // forever behind a stale busy flag from the killed process.
    expect(writeSpy).toHaveBeenCalledWith('new prompt after resume');
  });

  test('falls back to concatenated args when runtime has no prepareResumeLaunch (Codex)', () => {
    // Codex resumes via a subcommand (`codex resume <id>`) and its
    // initial launch carries NO conflicting flags, so the legacy
    // concat path is correct and must be preserved.
    const runtime = {
      meta: { id: 'codex', displayName: 'Codex' },
      resumeLaunchArgs: (id: string) => ['resume', id],
    } as unknown as RuntimeStrategy;
    const agent = new AgentService(runtime, { cwd: '/tmp/test', onExit: vi.fn() });
    Object.assign(agent, {
      strategy,
      agentReady: true,
      initialLaunch: { cmd: 'codex', args: [] },
    });

    agent.restart('resume-id', false);
    const [, , args] = spawnSpy.mock.calls[0];
    expect(args).toEqual(['resume', 'resume-id']);
  });
});
