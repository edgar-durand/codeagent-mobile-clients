/**
 * Agent-install integration-test DRIVER — runs INSIDE the Docker container
 * spawned by `apps/cli/__tests__/integration/agent-install.int.test.ts`.
 *
 * ─── What it proves ─────────────────────────────────────────────────────────
 * This is the ONE process in the whole gate, and that is the entire point.
 * The stale-PATH / half-finished-install failure class (fleet-1, 2026-08-14)
 * is invisible to any test that installs in one shell and probes in another:
 * the bug is that a **long-running daemon** captured its PATH before the
 * install happened, so the binary lands somewhere the daemon can never see.
 *
 * So this driver:
 *   1. starts (PATH is captured by Node here — deliberately minimal, systemd-like);
 *   2. runs the CANONICAL install snippet from `@codeam/shared`
 *      (`INSTALL_SNIPPETS`) through the REAL `runAgentInstallScript`;
 *   3. invokes the REAL adapter probe (`getAcpAdapter(agent).waitForBinary()`)
 *      — or, for the non-ACP agents, the exact binary resolution their runtime
 *      uses (`OsStrategy.findInPath`);
 *   4. spawns `<binary> --version` from THIS SAME process.
 *
 * A probe or a spawn that can't see a successfully-installed binary is the
 * production bug, and it fails the gate here instead of on a user's box.
 *
 * `half-link` mode reproduces the deterministic half-finished-npm-bin-link
 * state (`~/.local/bin/.codex-XXXX` present, `codex` absent) and drives the
 * REAL `ensureAgentBinaryForSwitch` retry-once recovery over it.
 *
 * ─── Not shipped ────────────────────────────────────────────────────────────
 * Test-only, like `headroom-runner-driver.ts`: its own tsup entry, excluded
 * from the npm `files` allowlist, copied into the container by the test.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { INSTALL_SNIPPETS, isKnownAgentId, type AgentId } from '@codeam/shared';
import { getAcpAdapter } from './agents/acp/adapters';
import { ensureAgentBinaryForSwitch } from './agents/acp/switch-agent';
import { runAgentInstallScript } from './commands/host/agent-install';
import { ensureCoderabbitInstalled } from './agents/coderabbit/installer';
import { AiderRuntimeStrategy } from './agents/aider/runtime';
import { createOsStrategy } from './os';

/** Marker the test greps for — keeps the result immune to installer chatter. */
const RESULT_MARKER = '__AGENT_INSTALL_RESULT__';

/** Generous: a cold `npm i -g` / curl installer on a slow runner. */
const INSTALL_TIMEOUT_MS = 240_000;
/** The switch path's own post-install probe window. */
const PROBE_TIMEOUT_MS = 30_000;

interface Checks {
  /** The fleet-1 precondition: the install target dir was NOT on the captured PATH. */
  installDirOffStartingPath?: boolean;
  /** The adapter spec this process resolved BEFORE the install (see `warmAdapterCache`). */
  adapterCommandAtStart?: string;
  installOk?: boolean;
  probeResolved?: boolean;
  versionExitZero?: boolean;
  versionOutput?: string;
  // half-link mode only
  halfLinkStaged?: boolean;
  probeFailedWhileLinkBroken?: boolean;
  ensureOk?: boolean;
  ensureError?: string;
  probeResolvedAfterEnsure?: boolean;
}

interface DriverResult {
  agentId: string;
  mode: string;
  ok: boolean;
  error?: string;
  pathAtStart: string;
  pathAtEnd: string;
  checks: Checks;
}

/** Non-ACP agents resolve their binary the way their RuntimeStrategy does. */
const NON_ACP_BINARIES: Partial<Record<AgentId, string>> = {
  coderabbit: 'coderabbit',
  aider: 'aider',
};

function emit(result: DriverResult): never {
  // eslint-disable-next-line no-console
  console.warn(`${RESULT_MARKER} ${JSON.stringify(result)}`);
  process.exit(result.ok ? 0 : 1);
}

/**
 * Directories each agent's installer targets. Used ONLY to assert the
 * precondition (that the install lands off the process's starting PATH) — the
 * probe itself never consults this list.
 */
function installDirsFor(agentId: AgentId): string[] {
  const home = process.env.HOME || os.homedir();
  switch (agentId) {
    case 'kimi':
      return [path.join(home, '.kimi-code', 'bin')];
    case 'opencode':
      return [path.join(home, '.opencode', 'bin')];
    default:
      // npm global-prefix bin + the curl installers' target (cursor, coderabbit)
      // + pip's `--user` fallback (aider).
      return [path.join(home, '.local', 'bin')];
  }
}

/** Run the agent's REAL install path. */
async function install(agentId: AgentId): Promise<{ ok: boolean; detail?: string }> {
  // CodeRabbit's codespace snippet is credential-only by design (the reviewer
  // CLI is installed on demand CLI-side), so its REAL install path is the
  // CLI's own installer — which also provisions the `unzip`/`git`
  // prerequisites the vendor script hard-requires.
  if (agentId === 'coderabbit') {
    const res = await ensureCoderabbitInstalled(createOsStrategy());
    return { ok: res.ok, detail: res.error };
  }
  const snippet = INSTALL_SNIPPETS[agentId];
  if (!snippet) return { ok: false, detail: `no canonical install snippet for ${agentId}` };
  const res = await runAgentInstallScript(snippet, {
    logScope: 'agent-install-driver',
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  return {
    ok: res.ok,
    detail: res.ok ? undefined : res.timedOut ? 'install timed out' : `install exit ${res.code}`,
  };
}

/**
 * The REAL probe: the ACP adapter's own `waitForBinary` for ACP agents, the
 * runtime's `findInPath` for the PTY agents. Never a bespoke check — a bespoke
 * check is exactly what would have let the fleet-1 bug through.
 */
async function probe(agentId: AgentId): Promise<boolean> {
  // Aider: drive the runtime's REAL launch preparation — that is where its
  // binary resolution (and its stale-PATH guard) actually lives.
  if (agentId === 'aider') {
    try {
      await new AiderRuntimeStrategy(createOsStrategy()).prepareLaunch();
      return true;
    } catch {
      return false;
    }
  }
  // CodeRabbit: `CoderabbitRuntimeStrategy.prepareInvocation` resolves its
  // binary with exactly this call (`this.os.findInPath(this.meta.binaryName)`);
  // reproducing the one line avoids plumbing a whole review invocation.
  const nonAcpBinary = NON_ACP_BINARIES[agentId];
  if (nonAcpBinary) return createOsStrategy().findInPath(nonAcpBinary) !== null;
  const spec = getAcpAdapter(agentId);
  if (!spec) return false;
  return spec.waitForBinary({ timeoutMs: PROBE_TIMEOUT_MS });
}

/**
 * The command a real spawn would use: the adapter's own `command` when it is
 * the agent binary itself (cursor/gemini/kimi/opencode), else the declared
 * `requiresAgentBinary` (codex/claude spawn Node against an npm adapter).
 */
function launchBinary(agentId: AgentId): string {
  const nonAcpBinary = NON_ACP_BINARIES[agentId];
  if (nonAcpBinary) return nonAcpBinary;
  const spec = getAcpAdapter(agentId);
  if (!spec) return agentId;
  return spec.command === process.execPath ? spec.requiresAgentBinary : spec.command;
}

/** `<binary> --version` from THIS process — the step a stale PATH breaks. */
function runVersion(agentId: AgentId): { exitZero: boolean; output: string } {
  const bin = launchBinary(agentId);
  const r = spawnSync(bin, ['--version'], {
    env: process.env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(0, 400);
  return {
    exitZero: !r.error && r.status === 0,
    output: r.error ? `${r.error.message} ${output}`.trim() : output,
  };
}

// ─── Modes ──────────────────────────────────────────────────────────────────

/**
 * Resolve the ACP adapter spec BEFORE the install runs.
 *
 * ⚠️ Load-bearing, not incidental. `getAcpAdapter` permanently CACHES a
 * successfully-resolved spec (see the cache doc in `adapters.ts`), and the
 * production `ensureAgentBinaryForSwitch` resolves the adapter as its very
 * FIRST step — before it decides to install anything. So on a real box the
 * cached `spec.command` is whatever the agent binary looked like when the
 * binary did NOT yet exist. A driver that resolved the adapter after the
 * install would cache a post-install `command` the daemon never sees, and the
 * `--version` step would silently pass on a box where production ENOENTs.
 */
function warmAdapterCache(agentId: AgentId): string | undefined {
  const spec = getAcpAdapter(agentId);
  return spec ? [spec.command, ...spec.args].join(' ') : undefined;
}

async function installProbeMode(agentId: AgentId, pathAtStart: string): Promise<DriverResult> {
  const checks: Checks = {};
  const startDirs = new Set(pathAtStart.split(path.delimiter).filter(Boolean));
  checks.installDirOffStartingPath = installDirsFor(agentId).every((d) => !startDirs.has(d));
  checks.adapterCommandAtStart = warmAdapterCache(agentId);

  const installed = await install(agentId);
  checks.installOk = installed.ok;
  if (!installed.ok) {
    return {
      agentId,
      mode: 'install-probe',
      ok: false,
      error: `install failed: ${installed.detail ?? 'unknown'}`,
      pathAtStart,
      pathAtEnd: process.env.PATH ?? '',
      checks,
    };
  }

  checks.probeResolved = await probe(agentId);
  const version = runVersion(agentId);
  checks.versionExitZero = version.exitZero;
  checks.versionOutput = version.output;

  const ok = checks.probeResolved === true && checks.versionExitZero === true;
  return {
    agentId,
    mode: 'install-probe',
    ok,
    error: ok
      ? undefined
      : checks.probeResolved !== true
        ? 'installed but the adapter probe never saw the binary (stale-PATH class)'
        : `probe passed but \`${launchBinary(agentId)} --version\` failed: ${version.output}`,
    pathAtStart,
    pathAtEnd: process.env.PATH ?? '',
    checks,
  };
}

/**
 * Deterministic reproduction of the half-finished npm bin link.
 *
 * npm links a global bin atomically: it writes `<bin>/.<name>-XXXXXXXX` then
 * renames it onto `<bin>/<name>`. The fleet-1 box was found mid-way — the
 * temp link existed, the real one did not, and the package itself was fully
 * installed — so every probe reported "installed but its binary never
 * appeared on PATH" while `npm i -g` kept short-circuiting.
 *
 * Precondition: `install-probe` for codex must have run first in this
 * container (the package must be present).
 */
async function halfLinkMode(agentId: AgentId, pathAtStart: string): Promise<DriverResult> {
  const checks: Checks = {};
  const home = process.env.HOME || os.homedir();
  const binDir = path.join(home, '.local', 'bin');
  const link = path.join(binDir, 'codex');
  const tempLink = path.join(binDir, '.codex-ykcFwAyA');

  const fail = (error: string): DriverResult => ({
    agentId,
    mode: 'half-link',
    ok: false,
    error,
    pathAtStart,
    pathAtEnd: process.env.PATH ?? '',
    checks,
  });

  if (!fs.existsSync(link)) return fail(`precondition failed: ${link} does not exist`);
  // Stage the half-finished state: temp link present, real link gone, package
  // untouched. `renameSync` is exactly the step npm was interrupted before.
  const target = fs.readlinkSync(link);
  fs.symlinkSync(target, tempLink);
  fs.unlinkSync(link);
  checks.halfLinkStaged = fs.existsSync(tempLink) && !fs.existsSync(link);
  if (!checks.halfLinkStaged) return fail('could not stage the half-finished link state');

  // The probe MUST fail now — otherwise the rest of this case proves nothing.
  checks.probeFailedWhileLinkBroken = !(await probeCodexQuick());
  if (!checks.probeFailedWhileLinkBroken) {
    return fail('probe still resolved with the bin link removed — the case is vacuous');
  }

  const res = await ensureAgentBinaryForSwitch(agentId, INSTALL_SNIPPETS[agentId]);
  checks.ensureOk = res.ok;
  if (!res.ok) checks.ensureError = res.error;

  checks.probeResolvedAfterEnsure = await probe(agentId);
  const version = runVersion(agentId);
  checks.versionExitZero = version.exitZero;
  checks.versionOutput = version.output;

  const ok =
    checks.ensureOk === true &&
    checks.probeResolvedAfterEnsure === true &&
    checks.versionExitZero === true;
  return {
    agentId,
    mode: 'half-link',
    ok,
    error: ok ? undefined : (checks.ensureError ?? 'recovery did not restore a runnable binary'),
    pathAtStart,
    pathAtEnd: process.env.PATH ?? '',
    checks,
  };
}

/** Short-budget probe used only to assert the broken-link precondition. */
function probeCodexQuick(): Promise<boolean> {
  const spec = getAcpAdapter('codex');
  if (!spec) return Promise.resolve(false);
  return spec.waitForBinary({ timeoutMs: 1_000 });
}

async function main(): Promise<void> {
  // Captured BEFORE any install runs — this is the daemon's view of the world.
  const pathAtStart = process.env.PATH ?? '';
  const [rawAgent, rawMode] = process.argv.slice(2);
  const mode = rawMode ?? 'install-probe';

  if (!rawAgent || !isKnownAgentId(rawAgent)) {
    emit({
      agentId: String(rawAgent ?? ''),
      mode,
      ok: false,
      error: `unknown agent id "${String(rawAgent ?? '')}"`,
      pathAtStart,
      pathAtEnd: pathAtStart,
      checks: {},
    });
  }
  const agentId: AgentId = rawAgent;

  try {
    const result =
      mode === 'half-link'
        ? await halfLinkMode(agentId, pathAtStart)
        : await installProbeMode(agentId, pathAtStart);
    emit(result);
  } catch (err) {
    emit({
      agentId,
      mode,
      ok: false,
      error: `driver threw: ${err instanceof Error ? err.message : String(err)}`,
      pathAtStart,
      pathAtEnd: process.env.PATH ?? '',
      checks: {},
    });
  }
}

void main();
