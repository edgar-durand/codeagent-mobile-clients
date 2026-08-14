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
import type { AgentId } from '@codeam/shared';
import {
  augmentUserLocalBinPaths,
  resolveCursorAgentBinary,
  waitForClaudeNativeBinary,
  waitForCommandOnPath,
  waitForCursorAgent,
  type WaitForClaudeBinaryOptions,
} from './agent-binary';
import { ensureKimiInstalled, augmentKimiPath } from '../kimi/installer';
import { ensureOpencodeInstalled, augmentOpencodePath } from '../opencode/installer';
import { isLocalSession } from '../../baton/gate';

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
      waitForBinary: (o) => {
        // Stale-PATH guard (fleet-1, 2026-08-14): a long-running host
        // process (e.g. this CLI under a systemd unit) can be missing
        // ~/.local/bin (or another npm global-prefix bin dir) entirely,
        // even though codex IS installed there — a bare PATH probe would
        // never see it. Same class as kimi/opencode's augment*Path guards.
        augmentUserLocalBinPaths();
        return waitForCommandOnPath('codex', o);
      },
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
  //
  // ⚠️ Windows stale-PATH: Cursor's installer drops `cursor-agent.exe` in
  // `%LOCALAPPDATA%\cursor-agent\` and adds that dir to the *User* PATH,
  // which a process already running (our CLI host, spawned at pairing)
  // never inherits — so a bare `cursor-agent` spawn ENOENTs even though
  // it's installed. `resolveCursorAgentBinary()` returns the absolute path
  // when present (sidestepping PATH), falling back to the bare name on
  // macOS/Linux and when it isn't in the known location yet.
  cursor: () => ({
    command: resolveCursorAgentBinary() ?? 'cursor-agent',
    args: ['acp'],
    requiresAgentBinary: 'cursor-agent',
    // ⚠️ Stale-PATH guard — the SAME class as codex/gemini above, but cursor
    // hid it behind a probe that passes anyway. Caught by the real per-agent
    // install gate (`__tests__/integration/agent-install.int.test.ts`):
    // on an in-session switch the adapter spec is resolved BEFORE the install
    // (that is `ensureAgentBinaryForSwitch`'s first step), so with no
    // cursor-agent on disk yet `resolveCursorAgentBinary()` returns null and
    // the spec is PERMANENTLY CACHED with the bare name `cursor-agent`. The
    // installer then drops the binary in ~/.local/bin — absent from a
    // systemd-minimal PATH — and `waitForCursorAgent` still reports READY
    // (it probes the absolute install location), so the switch proceeds and
    // the ACP client spawns the cached bare name → `spawn cursor-agent
    // ENOENT`. Augmenting PATH here makes the bare-name spawn resolve, which
    // is exactly what the codex/gemini branches already do.
    waitForBinary: (o) => {
      augmentUserLocalBinPaths();
      return waitForCursorAgent(o);
    },
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
    // gemini ships via `npm install -g @google/gemini-cli` → PATH binary,
    // same stale-PATH exposure as codex above.
    waitForBinary: (o) => {
      augmentUserLocalBinPaths();
      return waitForCommandOnPath('gemini', o);
    },
  }),
  // Kimi Code (Moonshot) speaks ACP natively via `kimi acp` — a stdio
  // JSON-RPC server that answers `initialize` (agentInfo `Kimi Code CLI`,
  // capabilities, authMethods) and prints no TUI banner. No npm adapter, just
  // the user-installed `kimi` binary on PATH. Same {@link AdapterSpec} shape as
  // gemini/cursor. Auth (KIMI_API_KEY env, or the ~/.kimi-code/credentials
  // login-state file) reaches kimi because the ACP client spawns the adapter
  // with `env: { ...process.env, ...extraEnv }`.
  kimi: () => ({
    command: 'kimi',
    args: ['acp'],
    requiresAgentBinary: 'kimi',
    // On a LOCAL `codeam pair` the CLI installs kimi ON DEMAND before spawning
    // (parity with the codespace bootstrap's KimiProvisioningStrategy) — so a
    // user who selected Kimi but hasn't installed the CLI doesn't hit a raw
    // `ENOENT — 'kimi' not found`. On a codespace/self-hosted box the backend
    // provisions it, so there we just wait for the binary to appear.
    waitForBinary: async (o) => {
      if (isLocalSession()) await ensureKimiInstalled();
      // ALWAYS fold ~/.kimi-code/bin into this process's PATH before probing:
      // on a self-hosted box the in-session agent switch installs kimi
      // mid-run, and the long-running process's PATH predates that dir — a
      // bare PATH probe (and the later `spawn('kimi')`) would never see the
      // binary (2026-08-13 fleet-1 live-switch failure). Idempotent no-op
      // when the dir is already present or kimi isn't installed there.
      augmentKimiPath();
      return waitForCommandOnPath('kimi', o);
    },
  }),
  // opencode speaks ACP natively via `opencode acp` — a stdio JSON-RPC server.
  // No npm adapter, just the user-installed `opencode` binary on PATH (baked in
  // the box image; provisioned on codespaces; installed on demand for a LOCAL
  // pair). Same {@link AdapterSpec} shape as gemini/cursor/kimi. Auth (the
  // ~/.local/share/opencode/auth.json login-state file) reaches opencode because
  // the ACP client spawns the adapter with `env: { ...process.env, ...extraEnv }`.
  opencode: () => ({
    command: 'opencode',
    args: ['acp'],
    requiresAgentBinary: 'opencode',
    waitForBinary: async (o) => {
      if (isLocalSession()) await ensureOpencodeInstalled();
      // Same stale-PATH guard as kimi above (~/.opencode/bin).
      augmentOpencodePath();
      return waitForCommandOnPath('opencode', o);
    },
  }),
};

/**
 * Cache of successfully-resolved adapter specs, keyed by agent id.
 *
 * Resolution (in particular {@link resolveBin} for the npm-adapter
 * shape) touches the filesystem/module-resolution cache, which is
 * NOT stable for the lifetime of a running process — an `npm
 * install -g` reinstall race can transiently delete and recreate a
 * package's files on disk while a session daemon is already live
 * (2026-07-17 incident: `@agentclientprotocol/claude-agent-acp` was
 * deleted mid-reinstall exactly as a codespace daemon dispatched a
 * new session — `resolveBin` returned `null`, which — because
 * `requiresAcp` used to be DERIVED from adapter resolution — flipped
 * the dispatch decision and silently downgraded Claude to its legacy
 * PTY runtime).
 *
 * Once an agent's adapter resolves successfully, we cache the spec
 * for the rest of the process's lifetime: a LATER filesystem rewrite
 * can never flip an already-running session's behavior. A resolution
 * FAILURE is deliberately NOT cached — the failure may be transient
 * (mid-reinstall), so the next call gets a fresh attempt (see
 * {@link resolveAcpAdapterWithRetry} for a bounded retry loop around
 * that).
 */
const resolvedAdapterCache = new Map<AgentId, AdapterSpec>();

/**
 * Resolve the adapter spec for an agent, or `null` if we have no
 * ACP coverage OR resolution is currently failing (see the cache
 * doc above). Used by the dispatch in `start.ts` — when this
 * returns null for an agent that HAS no adapter at all (aider,
 * cursor's legacy path is gone, coderabbit), the legacy PTY
 * `RuntimeStrategy` is used instead. For an agent that DOES have an
 * adapter (i.e. `requiresAcp(agent)` is true) a `null` return here
 * means "resolution is currently failing" — callers on that path
 * must retry (see {@link resolveAcpAdapterWithRetry}) and fail loudly
 * rather than silently falling back to PTY.
 */
export function getAcpAdapter(agent: AgentId): AdapterSpec | null {
  const cached = resolvedAdapterCache.get(agent);
  if (cached) return cached;
  const factory = REGISTRY[agent];
  if (!factory) return null;
  const spec = factory();
  if (spec) resolvedAdapterCache.set(agent, spec);
  return spec;
}

/**
 * Pure, STATIC dispatch predicate: does this agent run over ACP?
 *
 * `true` ⇒ ACP is the agent's ONLY launch path (claude / codex /
 * gemini / cursor / kimi today). There is no env flag and no PTY
 * fallback for these agents — the session must run over the typed
 * protocol or fail loudly. `false` ⇒ the agent has no ACP adapter and
 * runs over the legacy PTY runtime (aider, coderabbit).
 *
 * ⚠️ Deliberately does NOT touch adapter resolution (no
 * {@link getAcpAdapter} call, no filesystem/module lookup). Whether an
 * agent runs over ACP is a fact about the agent, fixed at REGISTRY
 * definition time — it must never depend on the transient state of
 * `node_modules` on disk. (Before the 2026-07-17 fix this called
 * `getAcpAdapter(agent) !== null`, so a mid-session module-resolution
 * hiccup for claude/codex could flip `requiresAcp('claude')` to
 * `false` and silently downgrade the session to the legacy PTY
 * runtime — see the adapter-cache doc above.)
 *
 * Extracted so `start.ts`'s dispatch decision is unit-testable
 * without standing up the whole run-loop.
 */
export function requiresAcp(agent: AgentId): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, agent);
}

export interface ResolveAdapterRetryOptions {
  /** Total time budget across all retry attempts. Default 8s. */
  timeoutMs?: number;
  /** Delay between attempts. Default 750ms. */
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Adapter resolver — defaults to {@link getAcpAdapter}. Injectable so a
   * test can drive a genuine fail-then-succeed sequence: the real
   * `getAcpAdapter` resolves on the very first call in this repo (the
   * adapter package IS installed), so it can't exercise the retry
   * transition on its own. A resolver that THROWS is treated exactly like
   * a transient `null` (keep retrying) — the same spawn-race class the
   * beads `bd-adapter` retry guards against (ENOENT/ETXTBSY during an npm
   * postinstall atomic rename), just surfaced as an exception instead of a
   * null. The production call sites never pass this, so their behavior is
   * unchanged (the default resolver never throws).
   */
  resolve?: (agent: AgentId) => AdapterSpec | null;
}

const DEFAULT_ADAPTER_RETRY_TIMEOUT_MS = 8_000;
const DEFAULT_ADAPTER_RETRY_POLL_MS = 750;

/**
 * Bounded retry around {@link getAcpAdapter} for an agent that IS
 * ACP-required (`requiresAcp(agent) === true`) but whose adapter spec
 * didn't resolve on the first try. Mirrors the beads `bd-adapter`
 * spawn-race retry (ENOENT/ETXTBSY during an npm postinstall atomic
 * rename) — the failure this guards against is the SAME class of race
 * applied to the ACP adapter package instead of `@beads/bd`.
 *
 * Resolves to the spec the instant resolution succeeds (and that
 * success is then permanently cached by {@link getAcpAdapter}), or
 * `null` once the time budget is exhausted — callers on the
 * ACP-required path must treat that `null` as a hard failure, never
 * as "fall back to PTY".
 */
export async function resolveAcpAdapterWithRetry(
  agent: AgentId,
  opts: ResolveAdapterRetryOptions = {},
): Promise<AdapterSpec | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ADAPTER_RETRY_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_ADAPTER_RETRY_POLL_MS;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const resolve = opts.resolve ?? getAcpAdapter;

  // A THROW from the resolver is the SAME transient-failure class as a
  // `null` (npm reinstall mid-rename) — swallow it and let the loop retry
  // rather than propagate. The default resolver (getAcpAdapter) never
  // throws, so this is a no-op for the production call sites.
  const attempt = (): AdapterSpec | null => {
    try {
      return resolve(agent);
    } catch {
      return null;
    }
  };

  let spec = attempt();
  if (spec) return spec;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(pollMs);
    spec = attempt();
    if (spec) return spec;
  }
  return null;
}

/**
 * Test-only — enumerate ids of every agent we ship an adapter for.
 * Lets the contract suite assert every registered adapter resolves
 * to a real binary path.
 */
export function listAcpAdapterIdsForTests(): AgentId[] {
  return Object.keys(REGISTRY) as AgentId[];
}

/**
 * Test-only — clear the resolved-adapter cache. Tests that mock
 * `resolveBin` / module resolution and assert on repeated
 * `getAcpAdapter` calls must reset the cache between cases, or a
 * PRIOR test's successful resolution leaks in as a cache hit.
 */
export function resetAcpAdapterCacheForTests(): void {
  resolvedAdapterCache.clear();
}
