import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeMemoryFile } from '../../src/agents/claude-memory-file';
import { ensureAgentStandard } from '../../src/agents/agent-standard';
import { ensureBeadsWorkflowHint } from '../../src/beads/workflow-hint';

// Owner report 2026-09-25: house (CodeAgent) sessions ignored the phone-brevity
// rules. Claude runs them with CLAUDE_CONFIG_DIR=~/.codeam/house-claude/<deploy>
// and reads CLAUDE.md from THAT dir, while the standard was written to
// ~/.claude/CLAUDE.md only.
describe('claudeMemoryFile', () => {
  it('follows CLAUDE_CONFIG_DIR when set', () => {
    expect(claudeMemoryFile(undefined, { CLAUDE_CONFIG_DIR: '/h/.codeam/house-claude/d1' })).toBe(
      path.join('/h/.codeam/house-claude/d1', 'CLAUDE.md'),
    );
  });
  it('defaults to ~/.claude/CLAUDE.md, and an explicit homeDir wins', () => {
    expect(claudeMemoryFile(undefined, {})).toBe(path.join(os.homedir(), '.claude', 'CLAUDE.md'));
    expect(claudeMemoryFile('/u', { CLAUDE_CONFIG_DIR: '/x' })).toBe(path.join('/u', '.claude', 'CLAUDE.md'));
  });
});

describe('house config dir receives the Agent Standard + beads hint', () => {
  let dir: string;
  const prev = process.env.CLAUDE_CONFIG_DIR;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'house-claude-'));
    process.env.CLAUDE_CONFIG_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes both blocks into $CLAUDE_CONFIG_DIR/CLAUDE.md', () => {
    ensureBeadsWorkflowHint();
    ensureAgentStandard();
    const out = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(out).toContain('<!-- codeam:beads-workflow -->');
    expect(out).toContain('<!-- codeam:agent-standard -->');
    expect(out).toMatch(/being read on a PHONE/);
  });
});
