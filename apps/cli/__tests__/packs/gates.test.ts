import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  canonicalCommit,
  detectChecksCommand,
  diffStat,
  gitHead,
  runChecks,
  type CommandRunner,
} from '../../src/packs/gates';

function fakeRunner(responses: Record<string, { code: number; stdout: string }>): CommandRunner {
  return async (file, args) => {
    const key = `${file} ${args.join(' ')}`;
    const hit = responses[key];
    return hit
      ? { code: hit.code, stdout: hit.stdout, stderr: '' }
      : { code: 1, stdout: '', stderr: `no fake for: ${key}` };
  };
}

describe('gates — mechanical capture', () => {
  it('gitHead returns the sha, or null outside a repo', async () => {
    const sha = 'f'.repeat(40);
    expect(await gitHead(fakeRunner({ 'git rev-parse HEAD': { code: 0, stdout: `${sha}\n` } }), '/x')).toBe(sha);
    expect(await gitHead(fakeRunner({}), '/x')).toBeNull();
  });

  it('canonicalCommit verifies the object is a commit, then abbreviates to 10 hex', async () => {
    const sha = 'a'.repeat(40);
    const run = fakeRunner({
      [`git rev-parse --verify ${sha}^{commit}`]: { code: 0, stdout: sha },
      [`git rev-parse --short=10 ${sha}`]: { code: 0, stdout: `${'a'.repeat(10)}\n` },
    });
    expect(await canonicalCommit(run, '/x', sha)).toBe('a'.repeat(10));
    // Not a commit → null, never a fabricated abbreviation.
    expect(await canonicalCommit(fakeRunner({}), '/x', sha)).toBeNull();
  });

  it('diffStat returns the summary tail line', async () => {
    const run = fakeRunner({
      'git diff --stat a..b': {
        code: 0,
        stdout: ' src/x.ts | 4 ++--\n 2 files changed, 10 insertions(+), 2 deletions(-)\n',
      },
    });
    expect(await diffStat(run, '/x', 'a', 'b')).toBe('2 files changed, 10 insertions(+), 2 deletions(-)');
  });

  it('runChecks captures pass/fail + a bounded output tail', async () => {
    const ok = await runChecks(fakeRunner({ 'sh -c npm test': { code: 0, stdout: 'all 12 passed' } }), '/x', 'npm test');
    expect(ok).toEqual({ command: 'npm test', passed: true, tail: 'all 12 passed' });
    const bad = await runChecks(fakeRunner({}), '/x', 'npm test');
    expect(bad?.passed).toBe(false);
  });
});

describe('detectChecksCommand', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-gates-'));
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('.codeam/pack.json checksCommand wins', () => {
    fs.mkdirSync(path.join(cwd, '.codeam'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.codeam', 'pack.json'), JSON.stringify({ checksCommand: 'make check' }));
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    expect(detectChecksCommand(cwd)).toBe('make check');
  });

  it('falls back to a REAL package.json test script', () => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    expect(detectChecksCommand(cwd)).toBe('npm test');
  });

  it("npm's placeholder test script does not count; nothing → null", () => {
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    );
    expect(detectChecksCommand(cwd)).toBeNull();
    fs.rmSync(path.join(cwd, 'package.json'));
    expect(detectChecksCommand(cwd)).toBeNull();
  });
});
