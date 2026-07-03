/**
 * Per-agent ACP adapter specs.
 *
 * Each entry describes how to spawn the adapter binary that exposes
 * the agent over JSON-RPC stdio. The adapters live as regular npm
 * dependencies of the CLI (bundled via `apps/cli/package.json` →
 * `npm install -g codeam-cli` pulls them automatically) so the user
 * never has to install anything extra.
 *
 * Adding a new ACP-compatible agent is a 3-step recipe:
 *   1. `npm install <adapter-package>` in `apps/cli/`.
 *   2. Add an entry below keyed by its {@link AgentId}.
 *   3. Ship. The dispatch in `start.ts` picks it up automatically —
 *      any agent with an adapter runs over ACP unconditionally.
 *
 * No per-agent runtime files, no parser per agent — that's the whole
 * point of replacing the hand-rolled per-agent strategies with the
 * single {@link AcpClient}.
 *
 * Each adapter still requires the underlying agent CLI on PATH (the
 * adapter is a thin protocol bridge over the real agent), but that
 * was already the case for the legacy strategies — no regression.
 */

import * as path from 'node:path';
import type { AgentId } from '@codeagent/shared';
import {
  waitForClaudeNativeBinary,
  waitForCommandOnPath,
  type WaitForClaudeBinaryOptions,
} from './agent-binary';

// CommonJS module — `require` is already in scope. Aliased so we
// keep a single grep target if we ever migrate the CLI to ESM.
const require_ = require;

/**
 * Concrete spawn recipe for one adapter. `command` is the absolute
 * executable path; `args` are appended verbatim. We run the
 * adapter's `bin` script directly through Node (rather than through
 * `npx` or a shell) so a globally-installed CLI doesn't need npm
 * resolution at run time and PATH doesn't matter.
 */
export interface AdapterSpec {
  /** Absolute path to a node-executable JS file. */
  command: string;
  /** Extra args appended after `command`. Empty for current adapters. */
  args: string[];
  /** Underlying agent binary the adapter wraps — surfaced in errors
   *  so the user sees "Install `claude` CLI" instead of a cryptic
   *  spawn failure from inside the adapter. */
  requiresAgentBinary: string;
  /**
   * Wait (bounded) until THIS agent's launch binary is installed, so the
   * spawn gate never launches the adapter before its binary has landed
   * on a freshly-provisioned codespace (the install races the gate).
   * Resolves `true` when ready, `false` on timeout. Each agent owns its
   * own check — the gate just calls this. Resolves instantly on the
   * happy path (binary already present → zero delay).
   */
  waitForBinary(opts?: { timeoutMs?: number }): Promise<boolean>;
}

/** Claude's native binary is the SDK's bundled optional platform pkg. */
function claudeBinaryWaiter(opts: WaitForClaudeBinaryOptions = {}): Promise<boolean> {
  return waitForClaudeNativeBinary(opts).then((p) => p !== null);
}

/**
 * Resolve the absolute path to a package's `bin` entry. Returns
 * `null` when the package is missing.
 */
function resolveBin(pkgName: string, binName?: string): string | null {
  try {
    const manifestPath = require_.resolve(`${pkgName}/package.json`);
    const manifest = require_(`${pkgName}/package.json`) as {
      bin?: string | Record<string, string>;
    };
    const pkgDir = path.dirname(manifestPath);
    const bin = manifest.bin;
    if (!bin) return null;
    if (typeof bin === 'string') return path.resolve(pkgDir, bin);
    const target = binName ?? Object.keys(bin)[0];
    if (!target || !bin[target]) return null;
    return path.resolve(pkgDir, bin[target]);
  } catch {
    return null;
  }
}

/**
 * Internal registry — exported through {@link getAcpAdapter} so
 * callers get a `null` for un-registered agents instead of an
 * Object-prototype quirk.
 */
const REGISTRY: Partial<Record<AgentId, () => AdapterSpec | null>> = {
  claude: () => {
    const bin = resolveBin('@agentclientprotocol/claude-agent-acp', 'claude-agent-acp');
    if (!bin) return null;
    return {
      command: process.execPath,
      args: [bin],
      requiresAgentBinary: 'claude',
      waitForBinary: claudeBinaryWaiter,
    };
  },
  codex: () => {
    const bin = resolveBin('@agentclientprotocol/codex-acp', 'codex-acp');
    if (!bin) return null;
    return {
      command: process.execPath,
      args: [bin],
      requiresAgentBinary: 'codex',
      // codex ships via `npm install -g @openai/codex` → PATH binary.
      waitForBinary: (o) => waitForCommandOnPath('codex', o),
    };
  },
  // Cursor speaks ACP NATIVELY via `cursor-agent acp` ("Start the Cursor
  // Agent as an ACP server") — no npm adapter package needed, just the
  // user-installed `cursor-agent` binary. Same {@link AdapterSpec} shape as
  // gemini below. This is why we do NOT bundle the deprecated
  // `cursor-agent-acp@0.1.1` npm adapter (old `@zed-industries/...` SDK).
  //
  // Running cursor over ACP (not the legacy PTY runtime) is REQUIRED: the
  // ACP client spawns the adapter with `env: { ...process.env, ...extraEnv }`
  // so the provisioned `CURSOR_API_KEY` actually reaches cursor-agent — the
  // interactive PTY path left cursor unauthenticated. It also gives the typed
  // streaming (tool calls / subagents) the other ACP agents emit.
  cursor: () => ({
    command: 'cursor-agent',
    args: ['acp'],
    requiresAgentBinary: 'cursor-agent',
    waitForBinary: (o) => waitForCommandOnPath('cursor-agent', o),
  }),
  // Gemini speaks ACP natively via `gemini --acp` — no npm adapter
  // package, just the user-installed `gemini` binary on PATH. Same
  // {@link AdapterSpec} shape; the only difference is `command` is
  // resolved from PATH at spawn time instead of being absolute.
  gemini: () => ({
    command: 'gemini',
    // `--skip-trust` bypasses Gemini's headless-mode workspace-trust
    // gate. Without it the CLI refuses to start in `--acp` mode with
    // "Gemini CLI is not running in a trusted directory" and the
    // ACP newSession call never returns, leaving mobile chat stuck
    // on "thinking…" forever. The equivalent env var is
    // `GEMINI_CLI_TRUST_WORKSPACE=true`; passing the flag is
    // cleaner because it survives whatever shell env the parent
    // codeam was launched from.
    args: ['--skip-trust', '--acp'],
    requiresAgentBinary: 'gemini',
    waitForBinary: (o) => waitForCommandOnPath('gemini', o),
  }),
};

/**
 * Resolve the adapter spec for an agent, or `null` if we have no
 * ACP coverage. Used by the dispatch in `start.ts` — when this
 * returns null the legacy PTY `RuntimeStrategy` is used instead
 * (aider, cursor, coderabbit).
 */
export function getAcpAdapter(agent: AgentId): AdapterSpec | null {
  const factory = REGISTRY[agent];
  return factory ? factory() : null;
}

/**
 * Pure dispatch predicate: does this agent run over ACP?
 *
 * `true` ⇒ ACP is the agent's ONLY launch path (claude / codex /
 * gemini today). There is no env flag and no PTY fallback for these
 * agents — if the adapter resolves, the session runs over the typed
 * protocol. `false` ⇒ the agent has no ACP adapter and runs over the
 * legacy PTY runtime (aider, cursor, coderabbit).
 *
 * Extracted so `start.ts`'s dispatch decision is unit-testable
 * without standing up the whole run-loop.
 */
export function requiresAcp(agent: AgentId): boolean {
  return getAcpAdapter(agent) !== null;
}

/**
 * Test-only — enumerate ids of every agent we ship an adapter for.
 * Lets the contract suite assert every registered adapter resolves
 * to a real binary path.
 */
export function listAcpAdapterIdsForTests(): AgentId[] {
  return Object.keys(REGISTRY) as AgentId[];
}
