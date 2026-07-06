/**
 * `codeam doctor` — diagnostic command for support triage.
 *
 * When a user reports "codeam doesn't work," running this one
 * command produces enough actionable data to close ~80% of
 * support cases without a back-and-forth. The output is:
 *
 *   - Human-readable by default (✓ / ✗ per check + a final
 *     diagnostic ID the user can paste into a bug report).
 *   - JSON via `--json` for scripted consumption.
 *
 * Checks are intentionally additive — a failure in any one of them
 * surfaces with a fix hint and bumps the exit code to 1, but the
 * other checks STILL run so the output is a complete picture, not
 * "first failure wins."
 *
 * NEVER prints tokens, credentials, or absolute home paths beyond
 * the standard config-dir name. Audit invariant.
 */

import { resolve as dnsResolve } from 'node:dns';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  resolveApiBaseUrl,
  AGENT_REGISTRY,
  getEnabledAgents,
} from '@codeam/shared';
import { createOsStrategy } from '../os';
import { loadCliConfig } from '../config';
import { log } from '../services/logger';
import pc from 'picocolors';

const dnsResolveP = promisify(dnsResolve);

interface CheckResult {
  /** Stable identifier used by the JSON reporter. */
  id: string;
  /** Human-readable label printed in the text reporter. */
  label: string;
  /** Pass / fail. Counts toward exit code unless `optional` is true. */
  ok: boolean;
  /** Short factual statement of what was observed. */
  detail: string;
  /** Actionable hint shown when ok=false. Omitted on success. */
  hint?: string;
  /**
   * When true, an `ok: false` result is informational and does NOT
   * flip the overall report.ok / exit code. Used for the
   * agent-binary probes: a missing `claude` / `codex` is something
   * the user wants to KNOW about, but it's not a CLI failure —
   * `codeam pair` offers to install the agent on first contact, so
   * the CLI itself works fine without them. The same logic protects
   * `codeam doctor` from failing in CI / containerized environments
   * where the agents aren't installed.
   */
  optional?: boolean;
}

interface DoctorReport {
  diagnosticId: string;
  cliVersion: string;
  node: string;
  platform: string;
  arch: string;
  apiBase: string;
  checks: CheckResult[];
  ok: boolean;
}

// ─── Individual checks ──────────────────────────────────────────────

async function checkDns(apiBase: string): Promise<CheckResult> {
  const host = (() => {
    try { return new URL(apiBase).host; } catch { return apiBase; }
  })();
  try {
    const addrs = await dnsResolveP(host);
    return {
      id: 'dns',
      label: `DNS resolves ${host}`,
      ok: true,
      detail: `${addrs.length} record(s)`,
    };
  } catch (err) {
    return {
      id: 'dns',
      label: `DNS resolves ${host}`,
      ok: false,
      detail: (err as Error).message,
      hint: 'Check your network connection / DNS configuration. The backend host MUST resolve before `codeam pair` can succeed.',
    };
  }
}

async function checkHealth(apiBase: string): Promise<CheckResult> {
  // Backend (api-v2 on Cloud Run) exposes `/health` (not /api/health)
  // — the @nestjs/terminus HealthController is mounted at the root.
  const url = `${apiBase}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const ok = res.ok;
    return {
      id: 'health',
      label: `GET ${url}`,
      ok,
      detail: `HTTP ${res.status}`,
      hint: ok ? undefined : 'Backend returned non-2xx. Try again in a few seconds; persistent failures indicate the API is degraded — check https://status.codeagent-mobile.com.',
    };
  } catch (err) {
    return {
      id: 'health',
      label: `GET ${url}`,
      ok: false,
      detail: (err as Error).name === 'AbortError' ? 'request timed out after 5s' : (err as Error).message,
      hint: 'Backend unreachable. Check your network + firewall; if your org proxies HTTPS, the proxy may need `*.codeagent-mobile.com` allow-listed.',
    };
  } finally {
    clearTimeout(timer);
  }
}

function checkConfigDir(): CheckResult {
  const dir = path.join(require('os').homedir(), '.codeam');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Probe write + read by round-tripping a sentinel file.
    const probe = path.join(dir, '.doctor-probe');
    fs.writeFileSync(probe, 'ok', { mode: 0o600 });
    const read = fs.readFileSync(probe, 'utf8');
    fs.unlinkSync(probe);
    if (read !== 'ok') throw new Error('write/read round-trip mismatch');
    return {
      id: 'config-dir',
      label: 'Config dir read/write',
      ok: true,
      detail: '~/.codeam (0700)',
    };
  } catch (err) {
    return {
      id: 'config-dir',
      label: 'Config dir read/write',
      ok: false,
      detail: (err as Error).message,
      hint: 'Cannot read/write ~/.codeam. Check directory ownership + disk space.',
    };
  }
}

function checkSessions(): CheckResult {
  try {
    const cfg = loadCliConfig();
    const count = cfg.sessions.length;
    return {
      id: 'sessions',
      label: 'Paired sessions',
      ok: true,
      // Just the count — NEVER the session ids / tokens.
      detail: `${count} paired`,
    };
  } catch (err) {
    return {
      id: 'sessions',
      label: 'Paired sessions',
      ok: false,
      detail: (err as Error).message,
      hint: 'Config file is unreadable or corrupt. Try `codeam logout` and re-pair.',
    };
  }
}

function checkAgentBinaries(): CheckResult[] {
  // Probe every enabled agent's binary. Skipping gated agents
  // because the user shouldn't have to install them — they're not
  // available in the CLI yet.
  const os = createOsStrategy();
  return getEnabledAgents().map((meta) => {
    const found = os.findInPath(meta.binaryName);
    return {
      id: `agent-${meta.id}`,
      label: `Agent binary: ${meta.displayName} (${meta.binaryName})`,
      ok: found !== null,
      detail: found ?? 'not on PATH',
      hint: found
        ? undefined
        : `Install ${meta.displayName} — \`codeam pair\` will offer to run the official installer the first time the agent is missing.`,
      // Missing agent binary is informational, not a CLI failure —
      // `codeam pair` handles bootstrap.
      optional: true,
    };
  });
}

function checkNodePty(): CheckResult {
  // `node-pty` is the Windows-only ConPTY backend (see
  // src/services/pty/windows-conpty.strategy.ts). macOS / Linux
  // use the Python PTY helper or direct spawn — node-pty isn't
  // touched at runtime there, so the check is N/A.
  if (process.platform !== 'win32') {
    return {
      id: 'node-pty',
      label: 'node-pty native module',
      ok: true,
      detail: 'not required on this platform',
    };
  }

  // Mirror the loader in windows-conpty.strategy.ts: in a published
  // install the binding lives at `<install>/dist/vendor/node-pty/`.
  // A bare `require('node-pty')` would miss the vendored path and
  // false-fail because we don't ship node-pty as a runtime dep.
  const vendoredPath = path.join(__dirname, 'vendor', 'node-pty');
  for (const target of [vendoredPath, 'node-pty']) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require(target);
      return {
        id: 'node-pty',
        label: 'node-pty native module',
        ok: true,
        detail: target === vendoredPath ? 'vendored bundle loaded' : 'loaded',
      };
    } catch {
      /* try next */
    }
  }
  return {
    id: 'node-pty',
    label: 'node-pty native module',
    ok: false,
    detail: 'vendored bundle missing or unloadable',
    hint:
      'Reinstall the CLI to fetch the vendored prebuilt binary:\n      npm install -g codeam-cli@latest\n    On Windows, antivirus may have quarantined `conpty.node` — restore it from quarantine or whitelist the install dir.',
  };
}

function checkChokidar(): CheckResult {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('chokidar');
    return {
      id: 'chokidar',
      label: 'chokidar file watcher',
      ok: true,
      detail: 'loaded',
    };
  } catch (err) {
    return {
      id: 'chokidar',
      label: 'chokidar file watcher',
      ok: false,
      detail: (err as Error).message.split('\n')[0],
      hint: 'Reinstall the CLI to re-resolve dependencies.',
    };
  }
}

// ─── Orchestration ─────────────────────────────────────────────────

// Build-time injection — tsup's `define` replaces this with the
// real version. The guard handles vitest runs (no replacement).
declare const __CLI_VERSION__: string;

export async function doctor(args: string[] = []): Promise<void> {
  const json = args.includes('--json');
  const cliVersion =
    typeof __CLI_VERSION__ !== 'undefined' ? __CLI_VERSION__ : '0.0.0-dev';
  const apiBase = resolveApiBaseUrl();
  const diagnosticId = randomUUID();
  log.info('doctor', `run id=${diagnosticId} cli=${cliVersion}`);

  // Run the network checks in parallel — they each have a 5 s
  // budget and there's no cross-dependency.
  const [dns, health] = await Promise.all([
    checkDns(apiBase),
    checkHealth(apiBase),
  ]);

  // Synchronous checks are cheap — order doesn't matter.
  const checks: CheckResult[] = [
    dns,
    health,
    checkConfigDir(),
    checkSessions(),
    ...checkAgentBinaries(),
    checkNodePty(),
    checkChokidar(),
  ];

  const report: DoctorReport = {
    diagnosticId,
    cliVersion,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    apiBase,
    checks,
    // Optional checks (e.g. agent-binary probes) report status but
    // don't gate exit code — see CheckResult.optional.
    ok: checks.filter((c) => !c.optional).every((c) => c.ok),
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHumanReport(report);
  }

  process.exit(report.ok ? 0 : 1);
}

function printHumanReport(r: DoctorReport): void {
  const out = process.stderr; // banner-style output to stderr; --json keeps stdout pure
  out.write(`\n${pc.bold('  codeam doctor')}\n\n`);
  out.write(`  ${pc.dim('cli')}      ${r.cliVersion}\n`);
  out.write(`  ${pc.dim('node')}     ${r.node}\n`);
  out.write(`  ${pc.dim('os')}       ${r.platform} ${r.arch}\n`);
  out.write(`  ${pc.dim('api')}      ${r.apiBase}\n`);
  // Surface the active override so a user reporting "doctor passes
  // but pair fails" sees immediately whether they're on dev.
  if (process.env.CODEAM_TEST_MODE === '1' || process.env.CODEAM_TEST_MODE?.toLowerCase() === 'true') {
    out.write(`  ${pc.dim('mode')}     ${pc.yellow('TEST_MODE — using dev preview')}\n`);
  } else if (process.env.CODEAM_API_URL) {
    out.write(`  ${pc.dim('mode')}     ${pc.yellow('CODEAM_API_URL override')}\n`);
  }
  out.write(`  ${pc.dim('diag id')}  ${r.diagnosticId}\n`);
  out.write('\n');
  for (const c of r.checks) {
    const mark = c.ok
      ? pc.green('✓')
      : c.optional
        ? pc.yellow('!') // informational — doesn't gate exit code
        : pc.red('✗');
    out.write(`  ${mark} ${c.label}${pc.dim(` — ${c.detail}`)}\n`);
    if (!c.ok && c.hint) {
      // Indent hint two extra spaces so it visually attaches to the
      // failure that prompted it.
      for (const line of c.hint.split('\n')) {
        out.write(`      ${pc.dim(line)}\n`);
      }
    }
  }
  out.write('\n');
  if (r.ok) {
    out.write(`  ${pc.green('All checks passed.')}\n\n`);
  } else {
    out.write(
      `  ${pc.red('Some checks failed.')} ${pc.dim('Paste the diagnostic id above when opening a bug report.')}\n\n`,
    );
  }
}
