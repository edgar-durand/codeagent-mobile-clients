import ignore from 'ignore';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logger';

/**
 * Curated exclude list for the REVIEW / changed-files reporter — a
 * ".gitignore for reviews", separate from git's own ignore.
 *
 * Why this exists (2026-07-16 incident): a `gcloud` SDK was installed straight
 * into a running 24/7 session's working directory. Its thousands of `.py`
 * files are untracked and were never in the user's `.gitignore`, so
 * `git status` surfaced them and the reporter shipped 641 files / +368,935
 * lines of false "changes" — spamming the review UI AND flooding
 * /api/files/changed + /api/review/* hard enough to OOM the backend.
 *
 * We can't edit users' `.gitignore`, so the reporter carries its OWN curated
 * list of dev-tool / SDK / toolchain directories that commonly get dropped into
 * a project dir but are never a reviewable change. Each entry is gitignore
 * syntax. Users can EXTEND it per-repo with `.codeam/reviewignore` (same
 * syntax) without touching their `.gitignore`. This complements — it does not
 * replace — git's ignore, the shared `isIgnoredFilePath` regex, and the
 * hard file-count cap in `collectRepoChangeset`.
 */
const CURATED_REVIEW_IGNORE: readonly string[] = [
  // Google Cloud SDK (the incident) — installs a huge python tree.
  'google-cloud-sdk/',
  '**/google-cloud-sdk/**',
  '.config/gcloud/',
  // Python package installs that land outside a venv (which is already covered).
  '**/site-packages/**',
  '**/dist-packages/**',
  '__pypackages__/',
  '.local/lib/',
  '**/.local/lib/**',
  'pip-wheel-metadata/',
  // JS package-manager stores/caches not already in isIgnoredFilePath's regex.
  '.pnpm-store/',
  '**/.pnpm-store/**',
  '.yarn/cache/',
  '.yarn/unplugged/',
  '.bun/',
  // Language toolchains dropped into $HOME/a project dir.
  '.rustup/',
  '.cargo/registry/',
  '.cargo/git/',
  'go/pkg/',
  '.nvm/',
  '.rbenv/',
  '.pyenv/',
  '.sdkman/',
  // Cloud / infra CLIs with bundled trees.
  '.azure/',
  '.aws/cli/',
  'awscli/',
  // CodeAgent's own runtime prefixes (never a user change).
  '.codeam/',
  'codeam-node20/',
];

/**
 * Build a review-ignore matcher for a repo. Combines the curated defaults with
 * an optional user-supplied `<repoRoot>/.codeam/reviewignore`. Returns a
 * predicate over REPO-RELATIVE paths (the shape `git status` yields).
 *
 * Cheap enough to build per changeset collection (one small file read + regex
 * compile), and doing so means edits to `.codeam/reviewignore` take effect on
 * the next turn without a restart.
 */
export function makeReviewIgnore(repoRoot: string): (relPath: string) => boolean {
  const ig = ignore().add(CURATED_REVIEW_IGNORE as string[]);
  try {
    const custom = fs.readFileSync(path.join(repoRoot, '.codeam', 'reviewignore'), 'utf8');
    ig.add(custom);
  } catch {
    /* no per-repo overrides — curated defaults only */
  }
  return (relPath: string): boolean => {
    if (!relPath) return false;
    try {
      // `ignore` rejects absolute paths / '.'; changeset paths are relative.
      return ig.ignores(relPath);
    } catch (err) {
      log.trace('review-ignore', `ignores() threw for "${relPath}"`, err);
      return false;
    }
  };
}
