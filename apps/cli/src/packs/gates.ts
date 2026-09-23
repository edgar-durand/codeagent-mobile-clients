import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PackHandoffRecord } from '@codeam/shared';

/**
 * Mechanical gate capture for pack handoffs — the runner never trusts the
 * model's claims: the commit is resolved and canonicalized with git (the
 * swarm-forge 10-hex rule), the diff-stat is computed, and the project checks
 * run for real when a command is available.
 */

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env?: Record<string, string>,
) => Promise<ExecResult>;

export const defaultCommandRunner: CommandRunner = (file, args, cwd, timeoutMs, env) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: env ? { ...process.env, ...env } : process.env,
      },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const rawCode: unknown = (err as NodeJS.ErrnoException).code;
          code = typeof rawCode === 'number' ? rawCode : 1;
        }
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });

const GIT_TIMEOUT_MS = 15_000;

/** Current HEAD sha, or null when the repo has no commits / isn't a repo. */
export async function gitHead(run: CommandRunner, cwd: string): Promise<string | null> {
  const res = await run('git', ['rev-parse', 'HEAD'], cwd, GIT_TIMEOUT_MS);
  return res.code === 0 ? res.stdout.trim() : null;
}

/** Canonical 10-hex abbreviation for a VERIFIED commit — git-validated, never
 *  model-claimed (swarm-forge's handoff-commit rule). */
export async function canonicalCommit(
  run: CommandRunner,
  cwd: string,
  sha: string,
): Promise<string | null> {
  const verify = await run(
    'git',
    ['rev-parse', '--verify', `${sha}^{commit}`],
    cwd,
    GIT_TIMEOUT_MS,
  );
  if (verify.code !== 0) return null;
  const short = await run('git', ['rev-parse', '--short=10', sha], cwd, GIT_TIMEOUT_MS);
  return short.code === 0 ? short.stdout.trim() : null;
}

/** Summary line of `git diff --stat from..to` (the "N files changed…" tail). */
export async function diffStat(
  run: CommandRunner,
  cwd: string,
  from: string,
  to: string,
): Promise<string> {
  const res = await run('git', ['diff', '--stat', `${from}..${to}`], cwd, GIT_TIMEOUT_MS);
  if (res.code !== 0) return '';
  const lines = res.stdout.trim().split('\n').filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1].trim() : '';
}

/** Repo-relative paths changed between two commits (`git diff --name-only`). */
export async function changedFiles(
  run: CommandRunner,
  cwd: string,
  from: string,
  to: string,
): Promise<string[]> {
  const res = await run('git', ['diff', '--name-only', `${from}..${to}`], cwd, GIT_TIMEOUT_MS);
  if (res.code !== 0) return [];
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** A repo-relative file from the working tree; null when it does not exist. */
export function readWorkspaceFile(cwd: string, relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(cwd, relPath), 'utf8');
  } catch {
    return null;
  }
}

const NO_TEST_PLACEHOLDER = 'echo "Error: no test specified"';
const CHECKS_TIMEOUT_MS = 5 * 60_000;

/**
 * The project checks command, when one is knowable: an explicit
 * `.codeam/pack.json` `{ "checksCommand": "…" }` wins; otherwise a real
 * `package.json` test script (npm's placeholder doesn't count). Null = no
 * checks available — the handoff records that honestly instead of pretending.
 */
export function detectChecksCommand(cwd: string): string | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.codeam', 'pack.json'), 'utf8')) as {
      checksCommand?: unknown;
    };
    if (typeof cfg.checksCommand === 'string' && cfg.checksCommand.trim().length > 0) {
      return cfg.checksCommand.trim();
    }
  } catch {
    /* no pack config — fall through */
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const test = pkg.scripts?.test;
    if (typeof test === 'string' && test.trim().length > 0 && !test.includes(NO_TEST_PLACEHOLDER)) {
      return 'npm test';
    }
  } catch {
    /* not a node project — fine */
  }
  return null;
}

/** Run the checks command (via the shell — it's a user-configured command
 *  line) bounded by a hard timeout; returns the captured verdict. `CI=1`
 *  keeps test runners in single-run mode — a watch-mode `npm test` would
 *  otherwise sit on the 5-minute timeout at EVERY stage boundary. */
export async function runChecks(
  run: CommandRunner,
  cwd: string,
  command: string,
): Promise<PackHandoffRecord['checks']> {
  const res = await run('sh', ['-c', command], cwd, CHECKS_TIMEOUT_MS, { CI: '1' });
  const combined = `${res.stdout}\n${res.stderr}`.trim();
  const tail = combined.split('\n').slice(-12).join('\n').slice(-1500);
  return { command, passed: res.code === 0, tail };
}
