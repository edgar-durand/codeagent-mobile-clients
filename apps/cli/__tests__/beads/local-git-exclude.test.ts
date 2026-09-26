import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLocalGitExclude } from '../../src/beads/provisioner';

// Break-it 2026-09-26: repos initialised before `bd init --stealth` kept
// beads files showing up as changes. The CLI excludes them LOCALLY (never a
// commit, never a tracked-file edit) on every provision.
let repo: string;
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-excl-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('ensureLocalGitExclude', () => {
  it('adds the patterns once and git then ignores beads state', () => {
    ensureLocalGitExclude(repo, ['.beads/', '.dolt/']);
    ensureLocalGitExclude(repo, ['.beads/', '.dolt/']);
    const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.match(/^\.beads\/$/gm)).toHaveLength(1);
    fs.mkdirSync(path.join(repo, '.beads'));
    fs.writeFileSync(path.join(repo, '.beads', 'issues.jsonl'), '{}\n');
    fs.writeFileSync(path.join(repo, 'real.ts'), 'x\n');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    expect(status).toContain('real.ts');
    expect(status).not.toContain('.beads');
  });

  it('is a no-op outside a git repo', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-plain-'));
    expect(() => ensureLocalGitExclude(plain, ['.beads/'])).not.toThrow();
    expect(fs.existsSync(path.join(plain, '.git'))).toBe(false);
    fs.rmSync(plain, { recursive: true, force: true });
  });
});
