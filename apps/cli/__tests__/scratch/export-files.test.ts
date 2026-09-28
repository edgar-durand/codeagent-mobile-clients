import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { listExportFiles, topPaths } from '../../src/scratch/export-files';

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
  it('honours .gitignore, keeps .git, drops node_modules and .env* even if tracked, generates .env.example', async () => {
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
    expect(rels.some((r) => r.startsWith('.git/'))).toBe(true);
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

  it('includes untracked files that are not gitignored', async () => {
    const dir = makeRepo({ 'README.md': 'hello' }); // no commit at all
    const list = await listExportFiles(dir);
    const rels = list.files.map((f) => f.rel);
    expect(rels).toContain('README.md');
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
