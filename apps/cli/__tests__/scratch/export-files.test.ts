import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { listExportFiles, topPaths } from '../../src/scratch/export-files';
import { configureGitCredentials } from '../../src/commands/host/workspace';

/**
 * mkdtemp, write `files` (relative path -> content, directories created as
 * needed), `git init -b main`, and — when `commitAll` — force-add and commit
 * EVERYTHING (including anything gitignored) so the export logic's hard
 * excludes (node_modules, .env*) and its .gitignore-honoring (dist/, etc.)
 * are exercised against real git state, not just "never got tracked".
 */
function makeRepo(files: Record<string, string>, opts: { commitAll?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-export-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  if (opts.commitAll) {
    execFileSync('git', [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t.com',
      '-C',
      dir,
      'add',
      '-A',
      '-f',
    ]);
    execFileSync('git', [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t.com',
      '-C',
      dir,
      'commit',
      '-q',
      '-m',
      'init',
    ]);
  }
  return dir;
}

describe('listExportFiles', () => {
  it('honours .gitignore, drops node_modules and .env* even if tracked, generates .env.example', async () => {
    const dir = makeRepo(
      {
        '.gitignore': 'dist/\n',
        'src/index.html': '<h1>x</h1>',
        'dist/bundle.js': 'x',
        'node_modules/a/index.js': 'x',
        '.env': 'API_KEY=secret\nPORT=3000\n',
        '.env.local': 'TOKEN=abc\n',
      },
      { commitAll: true },
    );
    const list = await listExportFiles(dir);
    const rels = list.files.map((f) => f.rel);
    expect(rels).toContain('src/index.html');
    expect(rels).not.toContain('dist/bundle.js');
    expect(rels.some((r) => r.startsWith('node_modules/'))).toBe(false);
    expect(rels).not.toContain('.env');
    expect(rels).not.toContain('.env.local');
    expect(list.envExample).toBe('API_KEY=\nPORT=\nTOKEN=\n');
  });

  it('keeps an existing .env.example and does not generate one', async () => {
    const dir = makeRepo(
      {
        'src/index.html': '<h1>x</h1>',
        '.env': 'A=1\n',
        '.env.example': 'A=\n',
      },
      { commitAll: true },
    );
    const list = await listExportFiles(dir);
    const rels = list.files.map((f) => f.rel);
    expect(rels).toContain('.env.example');
    expect(rels).not.toContain('.env');
    expect(list.envExample).toBeNull();
  });

  it('excludes the scratch marker .git/codeam-scratch', async () => {
    const dir = makeRepo({ 'src/index.html': '<h1>x</h1>' }, { commitAll: true });
    fs.writeFileSync(path.join(dir, '.git', 'codeam-scratch'), '');
    const list = await listExportFiles(dir);
    const rels = list.files.map((f) => f.rel);
    expect(rels).not.toContain('.git/codeam-scratch');
    expect(rels.some((r) => r.startsWith('.git/'))).toBe(true);
  });

  it('a NON-scratch repo (clone prepared with configureGitCredentials) exports source only: no .git/ at all, never the credentials file', async () => {
    const dir = makeRepo({ 'src/index.html': '<h1>x</h1>' }, { commitAll: true });
    await configureGitCredentials(dir, 'me/repo', 'ghs_supersecret');
    // Precondition: the credentials file really is on disk.
    expect(fs.readFileSync(path.join(dir, '.git', 'codeam-credentials'), 'utf8')).toContain('ghs_supersecret');
    const list = await listExportFiles(dir);
    const rels = list.files.map((f) => f.rel);
    expect(rels).toContain('src/index.html');
    expect(rels.some((r) => r.startsWith('.git/'))).toBe(false);
    expect(rels).not.toContain('.git/codeam-credentials');
  });

  it('a scratch repo keeps .git/ but never the marker or any .git/*credentials* file', async () => {
    const dir = makeRepo({ 'src/index.html': '<h1>x</h1>' }, { commitAll: true });
    fs.writeFileSync(path.join(dir, '.git', 'codeam-scratch'), '');
    fs.writeFileSync(path.join(dir, '.git', 'codeam-credentials'), 'https://x-access-token:tok@github.com\n');
    fs.writeFileSync(path.join(dir, '.git', 'git-credentials'), 'https://u:p@example.com\n');
    const list = await listExportFiles(dir);
    const rels = list.files.map((f) => f.rel);
    expect(rels).toContain('.git/HEAD');
    expect(rels).not.toContain('.git/codeam-scratch');
    expect(rels).not.toContain('.git/codeam-credentials');
    expect(rels).not.toContain('.git/git-credentials');
  });

  it('the scratch credentials filter only looks at TOP-LEVEL .git/ entries (a branch named feature-credentials is kept)', async () => {
    const dir = makeRepo({ 'src/index.html': '<h1>x</h1>' }, { commitAll: true });
    execFileSync('git', ['-C', dir, 'branch', 'feature-credentials']);
    fs.writeFileSync(path.join(dir, '.git', 'codeam-scratch'), '');
    fs.writeFileSync(path.join(dir, '.git', 'codeam-credentials'), 'secret');
    const list = await listExportFiles(dir);
    const rels = list.files.map((f) => f.rel);
    expect(rels).toContain('.git/refs/heads/feature-credentials');
    expect(rels).not.toContain('.git/codeam-credentials');
  });

  it('never lists a symbolic link (tracked or untracked), even one pointing at a real file outside the project', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-outside-'));
    fs.writeFileSync(path.join(outside, 'id_rsa'), 'PRIVATE KEY');
    const dir = makeRepo({ 'src/index.html': '<h1>x</h1>' });
    fs.symlinkSync(path.join(outside, 'id_rsa'), path.join(dir, 'tracked-link'));
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.com', '-C', dir, 'add', '-A']);
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.com', '-C', dir, 'commit', '-q', '-m', 'l']);
    fs.symlinkSync(path.join(outside, 'id_rsa'), path.join(dir, 'untracked-link'));
    fs.symlinkSync(path.join(outside, 'id_rsa'), path.join(dir, '.env'));
    const list = await listExportFiles(dir);
    const rels = list.files.map((f) => f.rel);
    expect(rels).toContain('src/index.html');
    expect(rels).not.toContain('tracked-link');
    expect(rels).not.toContain('untracked-link');
    expect(list.envExample).toBeNull();
  });

  it('a tracked .env* missing from the working tree is skipped, not a crash', async () => {
    const dir = makeRepo({ 'src/index.html': '<h1>x</h1>', '.env.local': 'A=1\n' }, { commitAll: true });
    fs.rmSync(path.join(dir, '.env.local'));
    const list = await listExportFiles(dir);
    expect(list.files.map((f) => f.rel)).toContain('src/index.html');
    expect(list.envExample).toBeNull();
  });

  it('includes untracked files that are not gitignored', async () => {
    const dir = makeRepo({ 'README.md': 'hello' }); // no commit at all
    const list = await listExportFiles(dir);
    const rels = list.files.map((f) => f.rel);
    expect(rels).toContain('README.md');
  });

  it('a non-git-repo cwd rejects with the exact English "not a git repository" text the scratch_export_zip handler pattern-matches', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-export-nogit-'));
    await expect(listExportFiles(dir)).rejects.toThrow(/not a git repository/i);
  });
});

describe('topPaths', () => {
  it('groups by first segment, biggest first', () => {
    expect(
      topPaths(
        [
          { rel: 'assets/a.png', bytes: 50 },
          { rel: 'assets/b.png', bytes: 30 },
          { rel: 'src/x.ts', bytes: 10 },
        ],
        2,
      ),
    ).toEqual([
      { path: 'assets/', bytes: 80 },
      { path: 'src/', bytes: 10 },
    ]);
  });

  it('groups a top-level file under its own name, not a trailing-slash bucket', () => {
    expect(topPaths([{ rel: 'README.md', bytes: 5 }])).toEqual([{ path: 'README.md', bytes: 5 }]);
  });

  it('defaults n to 5', () => {
    const files = Array.from({ length: 7 }, (_, i) => ({ rel: `d${i}/x`, bytes: i + 1 }));
    expect(topPaths(files)).toHaveLength(5);
  });
});
