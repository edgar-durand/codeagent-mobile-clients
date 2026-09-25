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

  // codeagent-zwp2: the hint now tells the agent to run `bd prime` only when
  // starting real work and never to paste bd commands/output into a reply.
  it('tells the agent to run bd via the shell tool and never paste bd output as a reply', () => {
    ensureBeadsWorkflowHint(home);
    const out = read();
    expect(out).toContain('via your shell tool');
    expect(out).toContain('Not needed to answer a greeting');
    expect(out).toMatch(/Never\s+paste `bd` commands or their raw output into your reply/);
  });

  // Fleet box 2026-09-24: a fresh session's first `bd ready` failed while the
  // project DB was still being created, and the agent spent its first turn on
  // bd doctor / bd bootstrap instead of the user's ticket — racing provisioning.
  it('tells the agent to keep working when bd fails and never repair beads itself', () => {
    ensureBeadsWorkflowHint(home);
    const out = read();
    expect(out).toMatch(/If a `bd` command\s+fails, carry on with the user's task/);
    expect(out).toMatch(/Never run `bd init`, `bd bootstrap`, `bd doctor --fix`/);
  });

  it('upgrades a STALE block from an older CLI in place (same markers, old text)', () => {
    const dir = path.join(home, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    const stale =
      '# My rules\n\n<!-- codeam:beads-workflow -->\n# Beads (bd)\n- Run `bd prime` for the full workflow context.\n<!-- codeam:beads-workflow -->\n\n# After\n';
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), stale);
    ensureBeadsWorkflowHint(home);
    const out = read();
    expect(out).toContain('# My rules');
    expect(out).toContain('# After');
    expect(out).toContain('via your shell tool');
    expect(out).not.toContain('- Run `bd prime` for the full workflow context.\n');
    expect(out.match(/codeam:beads-workflow/g) ?? []).toHaveLength(2);
    // And a second run is a no-op.
    ensureBeadsWorkflowHint(home);
    expect(read()).toBe(out);
  });

  it('never throws on an unwritable home (best-effort)', () => {
    // A path whose parent is a file, not a dir → mkdir/write fail internally.
    const file = path.join(home, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    expect(() => ensureBeadsWorkflowHint(file)).not.toThrow();
  });
});
