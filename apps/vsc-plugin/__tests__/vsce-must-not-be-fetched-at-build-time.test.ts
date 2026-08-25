/**
 * `vsce` must be an INSTALLED, pinned devDependency — never fetched by `npx`
 * while the job is running.
 *
 * THE INCIDENT (2026-08-25, ci.yml run 32882798560 on main @ df46ea8e):
 * "VS Code plugin (windows-latest)" went red while ubuntu-latest passed on the
 * identical commit. typecheck, tests and build ALL succeeded; the job died in
 * the `vsce package` step — and `vsce package` never actually ran. The step
 * was `npx @vscode/vsce package`, `@vscode/vsce` was declared NOWHERE in the
 * repo, so npx had to download and unpack its ~100-package tree into
 * `C:\npm\cache\_npx\<hash>\` on every invocation. That extraction raced
 * itself and collapsed into hundreds of
 *   TAR_ENTRY_ERROR EISDIR: illegal operation on a directory, open '...'
 *   TAR_ENTRY_ERROR ENOENT: no such file or directory, lstat '...'
 * on repeating paths, and npm exited 1.
 *
 * Proof it was never the code: the v2.67.3 release published the VS Code
 * extension from that exact SHA ("Publish VS Code plugin -> success").
 *
 * THE FIX is twofold and this test guards BOTH halves, because either one alone
 * silently decays back into the flake:
 *  1. `@vscode/vsce` is a pinned devDependency → `npm ci` installs it from the
 *     lockfile, deterministically, in a step that already exists and is already
 *     cached by setup-node.
 *  2. every call site passes `--no-install` → npx is FORBIDDEN from reaching
 *     the network. Without this, dropping the dependency would quietly restore
 *     the runtime fetch and nothing would fail until the next Windows race.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** Every file that may invoke vsce. Add new call sites here on purpose. */
const CALL_SITE_FILES = [
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  'apps/vsc-plugin/package.json',
];

describe('vsce is installed, not fetched at build time', () => {
  it('is a pinned devDependency of the vsc-plugin workspace', () => {
    const pkg = JSON.parse(read('apps/vsc-plugin/package.json')) as {
      devDependencies?: Record<string, string>;
    };
    const pinned = pkg.devDependencies?.['@vscode/vsce'];

    expect(pinned).toBeDefined();
    // EXACT, not a range: a range lets a fresh `npm ci` resolve a different
    // vsce than the one the lockfile and the last green release were built
    // with, which is how a packaging tool becomes a moving part.
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is present in the lockfile so `npm ci` can install it offline', () => {
    const lock = read('package-lock.json');
    expect(lock).toContain('node_modules/@vscode/vsce');
  });

  it.each(CALL_SITE_FILES)('never lets npx reach the network in %s', (file) => {
    const text = read(file);
    // Find every npx invocation that mentions vsce and assert the guard flag.
    const offenders = text
      .split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => /\bnpx\b/.test(line) && line.includes('@vscode/vsce'))
      .filter(({ line }) => !line.includes('--no-install'));

    expect(
      offenders,
      `npx would DOWNLOAD vsce here — add --no-install:\n${offenders
        .map((o) => `  ${file}:${o.no}  ${o.line}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('actually has at least one vsce call site, so the check above cannot pass vacuously', () => {
    const total = CALL_SITE_FILES.map(read)
      .join('\n')
      .split('\n')
      .filter((l) => /\bnpx\b/.test(l) && l.includes('@vscode/vsce')).length;

    expect(total).toBeGreaterThanOrEqual(3);
  });
});
