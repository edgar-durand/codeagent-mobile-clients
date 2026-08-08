import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { PackHandoffRecord, PackRunState } from '@codeam/shared';

/**
 * The pack run's durable ledger — plain files under `<cwd>/.codeam/packs/<runId>/`
 * (the swarm-forge file-ledger idea: the workspace is the source of truth; the
 * backend only holds a projection). `run.json` is the full `PackRunState`;
 * each completed stage additionally gets its own `NN-<role>.json` handoff for
 * a human-auditable trail. Never committed: the ledger is added to
 * `.git/info/exclude` (local ignore — no repo pollution) and the pack workflow
 * article forbids agents from touching `.codeam/` at all.
 */

export function packsDir(cwd: string): string {
  return path.join(cwd, '.codeam', 'packs');
}

export function runDir(cwd: string, runId: string): string {
  return path.join(packsDir(cwd), runId);
}

export function newRunId(): string {
  return `pk_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

/** Atomic write (tmp + rename) so a crash mid-write never corrupts the ledger. */
function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function saveRun(cwd: string, state: PackRunState): void {
  writeJsonAtomic(path.join(runDir(cwd, state.runId), 'run.json'), state);
}

export function saveStageHandoff(
  cwd: string,
  runId: string,
  stageIndex: number,
  role: string,
  handoff: PackHandoffRecord,
): void {
  const name = `${String(stageIndex + 1).padStart(2, '0')}-${role}.json`;
  writeJsonAtomic(path.join(runDir(cwd, runId), name), handoff);
}

/** The most recent persisted run, if any — `pack_status` hydration after a CLI
 *  restart (an in-memory runner does not survive; the ledger does). */
export function loadLatestRun(cwd: string): PackRunState | null {
  try {
    const dir = packsDir(cwd);
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (let i = entries.length - 1; i >= 0; i--) {
      const file = path.join(dir, entries[i], 'run.json');
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as PackRunState;
        if (parsed && typeof parsed.runId === 'string') return parsed;
      } catch {
        /* skip a corrupt/partial run dir */
      }
    }
  } catch {
    /* no ledger yet */
  }
  return null;
}

/** Keep the ledger out of `git status` without touching the repo's .gitignore:
 *  append to `.git/info/exclude` (local-only). Best-effort. */
export function ensureLedgerIgnored(cwd: string): void {
  try {
    const gitDir = path.join(cwd, '.git');
    if (!fs.existsSync(gitDir)) return;
    const exclude = path.join(gitDir, 'info', 'exclude');
    let existing = '';
    try {
      existing = fs.readFileSync(exclude, 'utf8');
    } catch {
      /* new file — fine */
    }
    if (existing.includes('.codeam/packs/')) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.writeFileSync(exclude, `${existing.trimEnd()}\n.codeam/packs/\n`.trimStart());
  } catch {
    /* best-effort — a dirty status line is cosmetic */
  }
}
