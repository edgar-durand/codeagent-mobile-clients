import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureScratchWorkflowHint } from '../../src/scratch/workflow-hint';

describe('ensureScratchWorkflowHint', () => {
  it('appends the block once, keeps existing content, and replaces a stale block in place', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-hint-'));
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, '# mine\n');
    ensureScratchWorkflowHint(undefined, file);
    const once = fs.readFileSync(file, 'utf8');
    expect(once.startsWith('# mine')).toBe(true);
    expect(once).toContain('suggest_save_project');
    expect(once).toContain('Never push, create repositories');
    ensureScratchWorkflowHint(undefined, file);
    expect(fs.readFileSync(file, 'utf8')).toBe(once);
    // stale block (same markers, older text) is rewritten, not duplicated
    fs.writeFileSync(file, once.replace('Never push, create repositories', 'OLD TEXT'));
    ensureScratchWorkflowHint(undefined, file);
    const fixed = fs.readFileSync(file, 'utf8');
    expect(fixed).toBe(once);
    expect(fixed.match(/codeam:scratch-workflow/g)).toHaveLength(2);
  });
});
