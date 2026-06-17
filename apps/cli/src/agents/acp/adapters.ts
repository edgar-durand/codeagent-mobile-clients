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
    };
  },
  codex: () => {
    const bin = resolveBin('@agentclientprotocol/codex-acp', 'codex-acp');
    if (!bin) return null;
    return {
      command: process.execPath,
      args: [bin],
      requiresAgentBinary: 'codex',
    };
  },
  // Cursor is intentionally NOT bundled right now. The only published
  // ACP adapter (`cursor-agent-acp@0.1.1`) still depends on the
  // deprecated `@zed-industries/agent-client-protocol` SDK; pulling it
  // back into the install would surface the deprecation warning to
  // every user of `codeam-cli`. The community forks (`cursor-acp`,
  // `fzx-cursor-acp`) use the current `@agentclientprotocol/sdk` but
  // are single-maintainer with no security track record we trust to
  // auto-bundle.
  //
  // Re-add this entry the moment an `@agentclientprotocol/cursor-acp`
  // ships under the official namespace, or upstream cursor-agent-acp
  // publishes a release that uses the new SDK:
  //
  //   cursor: () => {
  //     const bin = resolveBin('@agentclientprotocol/cursor-acp', 'cursor-acp');
  //     if (!bin) return null;
  //     return { command: process.execPath, args: [bin], requiresAgentBinary: 'cursor-agent' };
  //   },
  //
  // Until then `getAcpAdapter('cursor')` returns null and the dispatch
  // in start.ts runs cursor over the legacy PTY runtime — same
  // behaviour cursor users had before ACP was added.
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
