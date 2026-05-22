#!/usr/bin/env node
/**
 * Cross-OS smoke runner for `codeam-cli`.
 *
 * Invoked by `.github/workflows/ci.yml` on both `ubuntu-latest` and
 * `windows-latest`. Validates that the freshly-built binary boots,
 * the argument parser handles every documented `<cmd> --help`, the
 * config layer reads OK from `os.homedir()`, and the real production
 * backend at https://api.codeagent-mobile.com still speaks the
 * protocol the CLI expects.
 *
 * Pure Node (ESM) so we avoid shell-quoting differences between bash
 * (Linux runner) and pwsh (Windows runner). Talk to the user via
 * `console.log` — every line of output ends up in the CI job log.
 *
 * Environment knobs (set by CI, optional locally):
 *   SMOKE_CWD=home    Run every spawn with cwd = os.homedir(). This is
 *                     the regression guard for #43 — on a Windows runner
 *                     the home dir contains the legacy junctions whose
 *                     ACLs broke `codeam` v2.16.1.
 *   SMOKE_SKIP_BACKEND=1  Skip the real-network probes. Useful when the
 *                     backend is down and you want the local checks
 *                     only — CI does NOT set this; failures gate merges.
 *   CODEAM_API_URL    Override the API base URL (defaults to prod).
 */

import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(here, '..', 'dist', 'index.js');

const RUNNER_CWD =
  process.env.SMOKE_CWD === 'home' ? os.homedir() : process.cwd();
const API_BASE =
  process.env.CODEAM_API_URL ?? 'https://api.codeagent-mobile.com';
const PER_CHECK_TIMEOUT_MS = 30_000;

let failures = 0;
let passes = 0;

function logPass(label) {
  passes += 1;
  console.log(`  pass  ${label}`);
}
function logFail(label, detail) {
  failures += 1;
  console.log(`  FAIL  ${label}`);
  if (detail) console.log(detail.split('\n').map((l) => `        ${l}`).join('\n'));
}

/** Spawn the built CLI binary; return { status, stdout, stderr }. */
function runCli(argv, opts = {}) {
  const result = spawnSync(process.execPath, [BIN, ...argv], {
    cwd: opts.cwd ?? RUNNER_CWD,
    env: {
      ...process.env,
      CI: '1',
      // Force colour off so regex matches don't have to account for
      // ANSI escapes on platforms that report TTY-ish stdout.
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? PER_CHECK_TIMEOUT_MS,
  });
  return result;
}

function checkExitZeroAndStdout(label, argv, expectRe) {
  const r = runCli(argv);
  const ok = r.status === 0 && expectRe.test(r.stdout ?? '');
  if (ok) {
    logPass(`${label}  (cwd=${RUNNER_CWD})`);
    return r;
  }
  logFail(
    `${label}  (cwd=${RUNNER_CWD})`,
    `exit=${r.status}\nexpected stdout match: ${expectRe}\nstdout: ${r.stdout?.slice(0, 600) ?? ''}\nstderr: ${r.stderr?.slice(0, 600) ?? ''}`,
  );
  return r;
}

async function probeUrl(label, url, { acceptStatuses = [200, 204] } = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_CHECK_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    clearTimeout(timer);
    if (acceptStatuses.includes(res.status)) {
      logPass(`${label}  (status=${res.status})`);
      return res;
    }
    logFail(`${label}  (status=${res.status})`, `url=${url}`);
    return res;
  } catch (err) {
    logFail(`${label}  (network error)`, `url=${url}\n${err}`);
    return null;
  }
}

// ─── Local checks (no network) ──────────────────────────────────────
console.log(`\n[smoke] binary=${BIN}`);
console.log(`[smoke] cwd=${RUNNER_CWD}`);
console.log(`[smoke] api=${API_BASE}`);
console.log('');
console.log('[smoke] local checks:');

checkExitZeroAndStdout('codeam --version', ['--version'], /\d+\.\d+\.\d+/);
checkExitZeroAndStdout('codeam -v', ['-v'], /\d+\.\d+\.\d+/);
checkExitZeroAndStdout('codeam --help', ['--help'], /Usage/);
checkExitZeroAndStdout('codeam -h', ['-h'], /Usage/);
checkExitZeroAndStdout('codeam help', ['help'], /Usage/);

// Per-subcommand --help: keys must mirror the renderers registered
// in apps/cli/src/commands/subcommand-help.ts.
for (const cmd of ['pair', 'pair-auto', 'link', 'sessions', 'deploy', 'status', 'logout']) {
  checkExitZeroAndStdout(`codeam ${cmd} --help`, [cmd, '--help'], new RegExp(cmd, 'i'));
  checkExitZeroAndStdout(`codeam ${cmd} -h`, [cmd, '-h'], new RegExp(cmd, 'i'));
}

// `codeam sessions` with no args should print the "no sessions yet"
// banner and exit 0. Confirms config layer reads from $HOME without
// crashing on platforms where the home dir contains odd entries.
checkExitZeroAndStdout('codeam sessions (empty list)', ['sessions'], /session/i);

// ─── Backend checks (real network) ──────────────────────────────────
if (process.env.SMOKE_SKIP_BACKEND === '1') {
  console.log('\n[smoke] backend checks: skipped (SMOKE_SKIP_BACKEND=1)');
} else {
  console.log('\n[smoke] backend checks:');

  // 1. Pair dry-run — POST /api/pairing/code, validate response shape.
  checkExitZeroAndStdout(
    'codeam pair --dry-run (POST /api/pairing/code)',
    ['pair', '--dry-run', '--agent', 'claude'],
    /Pair dry-run OK/,
  );

  // 2. Link dry-run — POST /api/plugin/agents/claude_code/link, expect 401.
  checkExitZeroAndStdout(
    'codeam link claude --dry-run (POST /api/plugin/agents/claude_code/link → 401)',
    ['link', 'claude', '--dry-run'],
    /Link dry-run OK/,
  );

  // 3. /api/health connectivity probe. Treat ANY non-5xx response as
  //    "backend reachable" — the endpoint may legitimately 404 in
  //    older api-v2 cuts. A 5xx or network error means the backend
  //    layer is broken and we want the CI to gate on it.
  await probeUrl(`GET ${API_BASE}/api/health`, `${API_BASE}/api/health`, {
    acceptStatuses: [200, 201, 204, 301, 302, 401, 403, 404],
  });
}

// ─── Summary ─────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`[smoke] FAILED — ${passes} passed, ${failures} failed.`);
  process.exit(1);
}
console.log(`[smoke] OK — ${passes} checks passed.`);
