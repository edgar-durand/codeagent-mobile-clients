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
 *   3. Ship. The dispatch in `start.ts` picks it up automatically
 *      when `CODEAM_ACP_ENABLED=1` and the agent's id matches.
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
 * `null` when the package is missing (lets the dispatch fall back
 * to the legacy per-agent strategy without crashing).
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
  cursor: () => {
    const bin = resolveBin('cursor-agent-acp', 'cursor-agent-acp');
    if (!bin) return null;
    return {
      command: process.execPath,
      args: [bin],
      requiresAgentBinary: 'cursor-agent',
    };
  },
  // Gemini speaks ACP natively via `gemini --acp` — no npm adapter
  // package, just the user-installed `gemini` binary on PATH. Same
  // {@link AdapterSpec} shape; the only difference is `command` is
  // resolved from PATH at spawn time instead of being absolute.
  gemini: () => ({
    command: 'gemini',
    args: ['--acp'],
    requiresAgentBinary: 'gemini',
  }),
};

/**
 * Resolve the adapter spec for an agent, or `null` if we have no
 * ACP coverage. Used by the dispatch in `start.ts` — when this
 * returns null (or `CODEAM_ACP_ENABLED` isn't set), the existing
 * hand-rolled `RuntimeStrategy` is used instead.
 */
export function getAcpAdapter(agent: AgentId): AdapterSpec | null {
  const factory = REGISTRY[agent];
  return factory ? factory() : null;
}

/**
 * Test-only — enumerate ids of every agent we ship an adapter for.
 * Lets the contract suite assert every registered adapter resolves
 * to a real binary path.
 */
export function listAcpAdapterIdsForTests(): AgentId[] {
  return Object.keys(REGISTRY) as AgentId[];
}
