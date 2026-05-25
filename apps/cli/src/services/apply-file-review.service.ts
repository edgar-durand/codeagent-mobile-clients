import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';

/**
 * Execute the worktree side of an Epic B review action. The backend
 * pushes `apply_file_review` to the CLI's command queue when the user
 * clicks APPROVE_CHANGES / REJECT_CHANGES in the diff drawer; the
 * handler runs `git add <path>` or `git restore <path>` from the
 * file's enclosing repo.
 *
 *   - 'approved' → `git add <path>` (stages the agent's edit so the
 *                  user can later commit them as part of a
 *                  human-authored commit message).
 *   - 'rejected' → `git restore <path>` (discards the entire
 *                  worktree edit on the file — the agent's diff,
 *                  not just the rejected hunks. The drawer surfaces
 *                  a confirm dialog before firing this).
 *
 * Returns a structured result so the relay can ack the command back
 * to the backend with success/failure metadata.
 */
export interface ApplyFileReviewResult {
  ok: boolean;
  action: 'approved' | 'rejected';
  filePath: string;
  repoRoot?: string;
  error?: string;
}

export async function applyFileReview(
  workingDir: string,
  filePath: string,
  action: 'approved' | 'rejected',
): Promise<ApplyFileReviewResult> {
  if (filePath.includes('..') || path.isAbsolute(filePath)) {
    // `filePath` is supposed to be relative to the repo root. Reject
    // anything that tries to escape via `..` or hand us an absolute
    // path — both signal a misbehaving producer / compromised token.
    return { ok: false, action, filePath, error: 'invalid file path' };
  }

  // Walk up from the file's directory to the enclosing `.git/`. The
  // file watcher uses the same walk in turn-files/git-changeset.ts;
  // duplicating it here keeps this service self-contained without a
  // cross-module import that would be a layering smell.
  const absFile = path.resolve(workingDir, filePath);
  const repoRoot = findGitRoot(path.dirname(absFile));
  if (!repoRoot) {
    return {
      ok: false,
      action,
      filePath,
      error: `no enclosing git repo for ${filePath}`,
    };
  }

  const relInRepo = path.relative(repoRoot, absFile);
  if (!relInRepo || relInRepo.startsWith('..')) {
    return { ok: false, action, filePath, error: 'path escapes repo root' };
  }

  const args =
    action === 'approved'
      ? ['add', '--', relInRepo]
      : ['restore', '--', relInRepo];

  const result = await runGit(repoRoot, args);
  if (!result.ok) {
    return {
      ok: false,
      action,
      filePath,
      repoRoot,
      error: result.stderr.slice(0, 500) || `git ${args[0]} exited ${result.code}`,
    };
  }
  log.info(
    'reviewApply',
    `git ${args[0]} ${relInRepo} in ${repoRoot} — ok`,
  );
  return { ok: true, action, filePath, repoRoot };
}

interface GitResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('git', args, { cwd, env: process.env });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: (err as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
    proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
    proc.on('error', (err) =>
      resolve({ ok: false, code: -1, stdout, stderr: stderr + err.message }),
    );
    proc.on('close', (code) =>
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr }),
    );
  });
}

function findGitRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  const seen = new Set<string>();
  for (let i = 0; i < 256; i++) {
    if (seen.has(dir)) return null;
    seen.add(dir);
    try {
      const stat = fs.statSync(path.join(dir, '.git'), { throwIfNoEntry: false });
      if (stat && (stat.isDirectory() || stat.isFile())) return dir;
    } catch {
      // permission denied — keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
