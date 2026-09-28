import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nonInteractiveGitEnv } from '../commands/host/workspace';
import { SCRATCH_MARKER, isScratchWorkspace } from './workspace';

const run = promisify(execFile);

const ENV_FILE = /^\.env(\..+)?$/;
const KEEP_ENV = new Set(['.env.example', '.env.sample', '.env.template']);

export interface ExportFile {
  rel: string;
  bytes: number;
}

export interface ExportList {
  files: ExportFile[];
  totalBytes: number;
  envExample: string | null;
}

/**
 * Builds the export file list for the "Download ZIP" export (any git
 * session): gitignore-aware (tracked + untracked-but-not-ignored, via `git
 * ls-files --exclude-standard`), `node_modules/` and `.env*` are
 * hard-excluded even if committed, symbolic links are never listed (a link
 * could point anywhere on the box), and a `.env.example` is generated from
 * the excluded env files' KEYS ONLY (never their values) when no
 * example/sample/template already exists.
 *
 * `.git/` goes with the export ONLY for a scratch project (our own repo, its
 * history is the user's work). A cloned repo's `.git/` holds the clone token
 * (`configureGitCredentials` → `.git/codeam-credentials`) and whatever else
 * the host put there, so a non-scratch export is source only. Even for
 * scratch, the marker and any `*credentials*` file are never exported.
 */
export async function listExportFiles(cwd: string): Promise<ExportList> {
  // `LC_ALL=C` pins git's own messages (notably "fatal: not a git
  // repository…") to English regardless of the host locale — the
  // `scratch_export_zip` handler pattern-matches that exact string to
  // answer a user-safe error instead of a generic build failure.
  const gitOpts = { env: { ...nonInteractiveGitEnv(), LC_ALL: 'C' }, maxBuffer: 256 * 1024 * 1024 };
  // `-co --exclude-standard` lists tracked files (`-c`) UNION untracked
  // files not matched by .gitignore (`-o` + exclude-standard) — but `-c`
  // never applies exclude patterns, so a file that was force-added despite
  // being gitignored (`git add -f`) still comes back here. `-ci
  // --exclude-standard` is the complementary query: tracked files that DO
  // match an exclude pattern. Subtracting that set is what actually makes
  // this "gitignore-aware" for previously force-committed files.
  const [{ stdout: candidates }, { stdout: trackedIgnored }] = await Promise.all([
    run('git', ['-C', cwd, 'ls-files', '-co', '--exclude-standard', '-z'], gitOpts),
    run('git', ['-C', cwd, 'ls-files', '-ci', '--exclude-standard', '-z'], gitOpts),
  ]);
  const ignoredTracked = new Set(trackedIgnored.split('\0').filter(Boolean));
  const tracked = candidates.split('\0').filter((rel) => rel && !ignoredTracked.has(rel));
  const gitFiles = isScratchWorkspace(cwd)
    ? walk(path.join(cwd, '.git'))
        .map((abs) => path.relative(cwd, abs).split(path.sep).join('/'))
        .filter((rel) => rel !== `.git/${SCRATCH_MARKER}` && !/credentials/i.test(rel.slice(5)))
    : [];

  const envKeys = new Set<string>();
  let hasExample = false;
  const files: ExportFile[] = [];
  const seen = new Set<string>();
  for (const rel of [...tracked, ...gitFiles]) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const base = rel.split('/').pop()!;
    if (rel.startsWith('node_modules/') || rel.includes('/node_modules/')) continue;
    // lstat, never stat: a symlink (or a tracked file deleted from the
    // working tree) is skipped outright instead of followed.
    const st = fs.lstatSync(path.join(cwd, rel), { throwIfNoEntry: false });
    if (!st?.isFile()) continue;
    if (!rel.startsWith('.git/') && ENV_FILE.test(base) && !KEEP_ENV.has(base)) {
      for (const k of envKeysOf(path.join(cwd, rel))) envKeys.add(k);
      continue;
    }
    if (KEEP_ENV.has(base)) hasExample = true;
    files.push({ rel, bytes: st.size });
  }

  const envExample =
    !hasExample && envKeys.size > 0 ? [...envKeys].map((k) => `${k}=`).join('\n') + '\n' : null;
  return {
    files,
    totalBytes: files.reduce((s, f) => s + f.bytes, 0) + (envExample?.length ?? 0),
    envExample,
  };
}

function envKeysOf(file: string): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1])
    .filter((k): k is string => Boolean(k));
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name);
    return e.isDirectory() ? walk(abs) : e.isFile() ? [abs] : [];
  });
}

/** Groups files by their first path segment (`assets/`, `src/`, …), biggest first. */
export function topPaths(files: ExportFile[], n = 5): Array<{ path: string; bytes: number }> {
  const by = new Map<string, number>();
  for (const f of files) {
    const seg = f.rel.includes('/') ? `${f.rel.split('/')[0]}/` : f.rel;
    by.set(seg, (by.get(seg) ?? 0) + f.bytes);
  }
  return [...by]
    .map(([p, bytes]) => ({ path: p, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, n);
}
