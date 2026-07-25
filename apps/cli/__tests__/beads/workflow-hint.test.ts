import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureBeadsWorkflowHint } from '../../src/beads/workflow-hint';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bd-hint-'));
}

describe('ensureBeadsWorkflowHint', () => {
  let home: string;
  beforeEach(() => {
    home = tmpHome();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const read = () => fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');

  it('writes the bd workflow to ~/.claude/CLAUDE.md on a fresh home', () => {
    ensureBeadsWorkflowHint(home);
    const out = read();
    expect(out).toContain('bd (beads)');
    expect(out).toContain('bd remember');
    expect(out).toContain('do NOT use TodoWrite');
  });

  it('is idempotent — a second call does not duplicate the block', () => {
    ensureBeadsWorkflowHint(home);
    ensureBeadsWorkflowHint(home);
    const out = read();
    // The marker appears exactly twice (open + close) for ONE block, not four.
    const markers = out.match(/codeam:beads-workflow/g) ?? [];
    expect(markers).toHaveLength(2);
  });

  it('appends without clobbering an existing global CLAUDE.md', () => {
    const dir = path.join(home, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# My global rules\nAlways be concise.\n');
    ensureBeadsWorkflowHint(home);
    const out = read();
    expect(out).toContain('# My global rules');
    expect(out).toContain('Always be concise.');
    expect(out).toContain('bd (beads)');
  });

  it('never throws on an unwritable home (best-effort)', () => {
    // A path whose parent is a file, not a dir → mkdir/write fail internally.
    const file = path.join(home, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    expect(() => ensureBeadsWorkflowHint(file)).not.toThrow();
  });
});
