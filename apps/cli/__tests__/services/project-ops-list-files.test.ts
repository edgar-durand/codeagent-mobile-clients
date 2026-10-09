import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listProjectFiles } from '../../src/services/project-ops.service';

// Nightly 2026-10-07: a newcomer's Files tree showed `.beads/` and
// `.beads.gate.lock` — CodeAgent's own bookkeeping, not their code — because
// PROJECT_IGNORE predated beads.
describe('listProjectFiles — CodeAgent bookkeeping', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-tree-'));
    const write = (rel: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), 'x');
    };
    write('.beads/issues.jsonl');
    write('.beads/config.yaml');
    write('.beads.gate.lock');
    write('pkg/.beads/config.yaml');
    write('src/beads.ts');
    write('beads/README.md');
    write('my.beads.txt');
    write('.gitignore');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('hides .beads/ and its sibling lock files at any depth', async () => {
    const { files } = await listProjectFiles({ cwd: root });
    const paths = files.map((f) => f.path.split(path.sep).join('/'));
    expect(paths).toEqual(['.gitignore', 'beads/README.md', 'my.beads.txt', 'src/beads.ts']);
  });
});
