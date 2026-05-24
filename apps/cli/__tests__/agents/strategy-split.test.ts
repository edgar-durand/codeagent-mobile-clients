import { describe, it, expect, expectTypeOf } from 'vitest';

import { ClaudeRuntimeStrategy } from '../../src/agents/claude/runtime';
import { CodexRuntimeStrategy } from '../../src/agents/codex/runtime';
import { LinuxOsStrategy } from '../../src/os';
import type {
  AgentStrategy,
  BatchAgentStrategy,
  BatchInvocationInput,
  BatchInvocationOutput,
  InteractiveAgentStrategy,
} from '../../src/agents/strategy';

/**
 * Strategy-shape spec (#58). The split between InteractiveAgentStrategy
 * and BatchAgentStrategy is a TYPE-level concern — there's nothing
 * to assert at runtime beyond the `mode` discriminator. These tests
 * exist so:
 *
 *   1. Adding a new mode (e.g. `background`) without updating the
 *      union surfaces as a compile-time error in this file.
 *   2. A new agent that forgets to set `mode` fails to satisfy the
 *      InteractiveAgentStrategy contract.
 *   3. The narrowing path the rest of the codebase relies on
 *      (`if (agent.mode === 'batch') ...`) actually works.
 */

describe('AgentStrategy split', () => {
  describe('Interactive agents (Claude + Codex)', () => {
    it.each([
      ['Claude', new ClaudeRuntimeStrategy(new LinuxOsStrategy())],
      ['Codex', new CodexRuntimeStrategy(new LinuxOsStrategy())],
    ])('%s.mode === "interactive"', (_name, agent) => {
      expect(agent.mode).toBe('interactive');
    });

    it('narrows to InteractiveAgentStrategy when `mode === "interactive"`', () => {
      const agent: AgentStrategy = new ClaudeRuntimeStrategy(new LinuxOsStrategy());
      if (agent.mode === 'interactive') {
        // The interactive-only methods MUST be callable here. If they
        // aren't, TS narrowing is broken and the test fails to compile.
        expect(typeof agent.filterTuiOutput).toBe('function');
        expect(typeof agent.detectInteractivePrompt).toBe('function');
        expect(typeof agent.resumeLaunchArgs).toBe('function');
      } else {
        throw new Error('expected interactive narrowing');
      }
    });
  });

  describe('BatchAgentStrategy contract (stub)', () => {
    /** Minimal in-spec fake to confirm the BatchAgentStrategy shape
     *  type-checks. Replaced by the real CodeRabbit strategy in #59. */
    class FakeBatchAgent implements BatchAgentStrategy {
      readonly id = 'coderabbit' as never; // AgentId union doesn't include 'coderabbit' yet
      readonly meta = { id: 'coderabbit' } as never;
      readonly mode = 'batch' as const;
      readonly os = new LinuxOsStrategy();
      credentialLocator() {
        return {
          publicId: 'coderabbit',
          vendor: 'CodeRabbit',
          hint: '~/.coderabbit/auth',
          watchPaths: () => [],
          extract: async () => null,
        };
      }
      loginLauncher() {
        return {
          ensureInstalled: async () => true,
          launch: () => { throw new Error('not used'); },
        };
      }
      getDefaultArgs() {
        return ['--json'];
      }
      async prepareInvocation(input: BatchInvocationInput) {
        return { cmd: 'coderabbit', args: [...this.getDefaultArgs(), ...(input.extraArgs ?? [])] };
      }
      parseOutput(args: { exitCode: number; stdout: string; stderr: string }): BatchInvocationOutput {
        return {
          exitCode: args.exitCode,
          markdown: args.stdout,
          rawStdout: args.stdout,
          rawStderr: args.stderr,
        };
      }
      async runOneShot(input: BatchInvocationInput): Promise<BatchInvocationOutput> {
        // The real impl spawns + waits + parses; the fake just
        // exercises the prepareInvocation → parseOutput pipe.
        const { cmd, args } = await this.prepareInvocation(input);
        return this.parseOutput({ exitCode: 0, stdout: `ran ${cmd} ${args.join(' ')}`, stderr: '' });
      }
    }

    const agent = new FakeBatchAgent();

    it('discriminator is "batch"', () => {
      expect(agent.mode).toBe('batch');
    });

    it('getDefaultArgs returns a string[]', () => {
      expect(agent.getDefaultArgs()).toEqual(['--json']);
    });

    it('prepareInvocation merges defaults + caller args', async () => {
      const { args } = await agent.prepareInvocation({ extraArgs: ['--pr', '123'] });
      expect(args).toEqual(['--json', '--pr', '123']);
    });

    it('runOneShot pipes through parseOutput', async () => {
      const out = await agent.runOneShot({ prRef: '123' });
      expect(out.exitCode).toBe(0);
      expect(out.markdown).toContain('coderabbit');
    });

    it('narrows to BatchAgentStrategy when `mode === "batch"`', () => {
      const candidate: AgentStrategy = agent;
      if (candidate.mode === 'batch') {
        expectTypeOf(candidate).toHaveProperty('runOneShot');
        expectTypeOf(candidate).not.toHaveProperty('filterTuiOutput');
      } else {
        throw new Error('expected batch narrowing');
      }
    });
  });
});
