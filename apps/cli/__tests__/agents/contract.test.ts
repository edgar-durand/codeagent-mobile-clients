import { describe, it, expect } from 'vitest';
import { AGENT_REGISTRY, type AgentId } from '@codeagent/shared';
import {
  createAgentStrategyForTests,
  listRegisteredAgentIdsForTests,
} from '../../src/agents/registry';
import { LinuxOsStrategy } from '../../src/os';
import type {
  AgentStrategy,
  BatchAgentStrategy,
  InteractiveAgentStrategy,
} from '../../src/agents/strategy';

/**
 * Agent contract suite (#62).
 *
 * One spec runs against EVERY registered agent strategy — enabled or
 * gated — so:
 *
 *   1. A new agent that forgets to implement a base method fails
 *      this suite, not in production.
 *   2. An interface widening (new method on InteractiveAgentStrategy)
 *      forces every Interactive agent to grow the method before
 *      merging, instead of silently coasting on an `as` cast.
 *   3. Adding an entry to AGENT_REGISTRY without registering a
 *      builder in `runtimeBuilders` surfaces immediately.
 *   4. Gated agents (`enabled: false`) stay healthy — without this
 *      suite they'd rot quietly until the flag flipped.
 *
 * The suite uses `createAgentStrategyForTests` to bypass the
 * `enabled` gate. Production code never reaches for that helper.
 */

const agentIds = listRegisteredAgentIdsForTests();
const os = new LinuxOsStrategy();

describe('Agent strategy registry surface', () => {
  it('every registered agent id has a matching AGENT_REGISTRY entry', () => {
    for (const id of agentIds) {
      expect(AGENT_REGISTRY[id], `${id} missing from AGENT_REGISTRY`).toBeDefined();
    }
  });

  it('every enabled AGENT_REGISTRY entry has a registered builder', () => {
    const enabledIds = Object.values(AGENT_REGISTRY)
      .filter((m) => m.enabled)
      .map((m) => m.id);
    for (const id of enabledIds) {
      expect(agentIds, `${id} enabled in registry but no builder wired`).toContain(id);
    }
  });
});

describe.each(agentIds)('AgentStrategy base contract: %s', (id) => {
  const agent: AgentStrategy = createAgentStrategyForTests(id, os);

  it('id matches the agent id passed to the factory', () => {
    expect(agent.id).toBe(id);
  });

  it('meta matches AGENT_REGISTRY[id]', () => {
    expect(agent.meta).toEqual(AGENT_REGISTRY[id as AgentId]);
  });

  it('composes the OsStrategy passed at construction time', () => {
    expect(agent.os).toBe(os);
    expect(agent.os.id).toBe('linux');
  });

  it('declares a valid mode discriminator', () => {
    expect(['interactive', 'batch']).toContain(agent.mode);
  });

  it('credentialLocator returns the per-agent probe shape', () => {
    const loc = agent.credentialLocator();
    expect(typeof loc.publicId).toBe('string');
    expect(loc.publicId.length).toBeGreaterThan(0);
    expect(typeof loc.vendor).toBe('string');
    expect(typeof loc.hint).toBe('string');
    expect(typeof loc.watchPaths).toBe('function');
    expect(typeof loc.extract).toBe('function');
    // watchPaths must always return an array (chokidar input).
    expect(Array.isArray(loc.watchPaths())).toBe(true);
  });

  it('loginLauncher returns ensureInstalled + launch', () => {
    const launcher = agent.loginLauncher();
    expect(typeof launcher.ensureInstalled).toBe('function');
    expect(typeof launcher.launch).toBe('function');
  });
});

// ─── Interactive-only invariants ────────────────────────────────────

const interactiveIds = agentIds.filter(
  (id) => createAgentStrategyForTests(id, os).mode === 'interactive',
);

describe.each(interactiveIds)('InteractiveAgentStrategy contract: %s', (id) => {
  const agent = createAgentStrategyForTests(id, os) as InteractiveAgentStrategy;

  it('exposes all required interactive methods as functions', () => {
    const required = [
      'prepareLaunch',
      'resumeLaunchArgs',
      'resolveHistoryDir',
      'parseHistoryFile',
      'getCurrentUsage',
      'fetchWeeklyUsage',
      'listModels',
      'changeModelInstruction',
      'summarizeInstruction',
      'filterTuiOutput',
      'detectInteractivePrompt',
    ] as const;
    for (const m of required) {
      expect(typeof agent[m], `${id}.${m} not a function`).toBe('function');
    }
  });

  it('resumeLaunchArgs returns a string[] (possibly empty)', () => {
    expect(Array.isArray(agent.resumeLaunchArgs('any-session-id'))).toBe(true);
  });

  it('filterTuiOutput is idempotent — filter(filter(x)) === filter(x)', () => {
    const sample = [
      '⠁ thinking…',
      'Hello, real agent reply',
      '',
      'Another line',
    ];
    const once = agent.filterTuiOutput(sample);
    const twice = agent.filterTuiOutput(once);
    expect(twice).toEqual(once);
  });

  it('detectInteractivePrompt returns null on empty input', () => {
    expect(agent.detectInteractivePrompt([])).toBeNull();
  });

  it('listModels yields at least one model with a positive context window', async () => {
    const models = await agent.listModels();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(typeof m.id).toBe('string');
      expect(typeof m.label).toBe('string');
    }
  });

  it('changeModelInstruction returns { type: pty|restart, … }', () => {
    const r = agent.changeModelInstruction('some-model-id');
    expect(['pty', 'restart']).toContain(r.type);
    // When type=pty, ptyInput must carry the slash command.
    if (r.type === 'pty') {
      expect(typeof r.ptyInput).toBe('string');
      expect(r.ptyInput!.length).toBeGreaterThan(0);
    }
  });

  it('summarizeInstruction returns a non-empty ptyInput for normal mode', () => {
    const r = agent.summarizeInstruction('normal');
    expect(typeof r.ptyInput).toBe('string');
    expect(r.ptyInput.length).toBeGreaterThan(0);
  });
});

// ─── Batch-only invariants ──────────────────────────────────────────

const batchIds = agentIds.filter(
  (id) => createAgentStrategyForTests(id, os).mode === 'batch',
);

describe.each(batchIds)('BatchAgentStrategy contract: %s', (id) => {
  const agent = createAgentStrategyForTests(id, os) as BatchAgentStrategy;

  it('exposes all required batch methods as functions', () => {
    const required = ['getDefaultArgs', 'prepareInvocation', 'parseOutput', 'runOneShot'] as const;
    for (const m of required) {
      expect(typeof agent[m], `${id}.${m} not a function`).toBe('function');
    }
  });

  it('getDefaultArgs returns a string[] (possibly empty)', () => {
    expect(Array.isArray(agent.getDefaultArgs())).toBe(true);
  });

  it('parseOutput handles the empty stdout case without throwing', () => {
    const out = agent.parseOutput({ exitCode: 0, stdout: '', stderr: '' });
    expect(typeof out.exitCode).toBe('number');
    // Hunks may be undefined or empty for the empty-stdout case.
    if (out.hunks !== undefined) expect(Array.isArray(out.hunks)).toBe(true);
  });

  it('parseOutput preserves the exit code', () => {
    const out = agent.parseOutput({ exitCode: 42, stdout: '', stderr: '' });
    expect(out.exitCode).toBe(42);
  });
});
