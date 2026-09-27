/**
 * Break-it 2026-09-26, against a REAL git repo: the Files review listed new
 * directories as "files" (`.codex/`, `.cursor/`, `.agents/` with +0 −0), our own
 * beads state (`.beads/issues.jsonl`), and — earlier — a unix socket.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectRepoChangeset } from '../../src/services/turn-files/git-changeset';

let repo: string;
let server: net.Server | null = null;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-rg-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
  git('add', '.');
  git('commit', '-qm', 'init');
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('collectRepoChangeset on a real repo', () => {
  it('lists the FILES of a new directory, never the directory itself', async () => {
    fs.mkdirSync(path.join(repo, '.cursor', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.cursor', 'rules', 'style.mdc'), 'a\nb\n');
    const rows = (await collectRepoChangeset({ repoRoot: repo, repoPath: '.', repoName: 'r' })) ?? [];
    const paths = rows.map((r) => r.filePath);
    expect(paths).toContain('.cursor/rules/style.mdc');
    expect(paths.some((p) => p.endsWith('/'))).toBe(false);
    expect(rows.find((r) => r.filePath === '.cursor/rules/style.mdc')?.linesAdded).toBe(2);
  });

  it('never reports beads state or a unix socket', async () => {
    fs.mkdirSync(path.join(repo, '.beads'));
    fs.writeFileSync(path.join(repo, '.beads', 'issues.jsonl'), '{}\n');
    fs.mkdirSync(path.join(repo, 'cc-socks'));
    const sock = path.join(repo, 'cc-socks', '1522.sock');
    server = net.createServer();
    await new Promise<void>((r) => server!.listen(sock, () => r()));
    fs.writeFileSync(path.join(repo, 'real.ts'), 'x\n');
    const paths = ((await collectRepoChangeset({ repoRoot: repo, repoPath: '.', repoName: 'r' })) ?? []).map(
      (r) => r.filePath,
    );
    expect(paths).toEqual(['real.ts']);
  });
});
