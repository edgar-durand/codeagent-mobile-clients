import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AGENT_STANDARD_MARKER, AGENT_STANDARD_TEXT } from '@codeam/shared';
import {
  ensureAgentStandard,
  maybePrefaceAgentStandard,
  _agentStandardSeam,
} from '../../src/agents/agent-standard';
import type { PromptBlock } from '../../src/agents/acp/buildAcpPromptBlocks';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-std-'));
}

describe('ensureAgentStandard (Claude rail → ~/.claude/CLAUDE.md)', () => {
  let home: string;
  beforeEach(() => {
    home = tmpHome();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });
  const read = () => fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');

  it('appends the standard on a fresh home', () => {
    ensureAgentStandard(home);
    const out = read();
    expect(out).toContain('# Working standard');
    expect(out).toContain('Stay in scope');
    expect(out).toContain(AGENT_STANDARD_MARKER);
  });

  it('is idempotent — the marker appears exactly twice (open + close), never duplicated', () => {
    ensureAgentStandard(home);
    ensureAgentStandard(home);
    const markers = read().match(/codeam:agent-standard/g) ?? [];
    expect(markers).toHaveLength(2);
  });

  it('appends without clobbering an existing global CLAUDE.md (e.g. the beads hint)', () => {
    const dir = path.join(home, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Beads\nuse bd\n');
    ensureAgentStandard(home);
    const out = read();
    expect(out).toContain('# Beads');
    expect(out).toContain('# Working standard');
  });

  it('never throws on an unwritable home (best-effort)', () => {
    const file = path.join(home, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    expect(() => ensureAgentStandard(file)).not.toThrow();
  });
});

describe('maybePrefaceAgentStandard (non-Claude rail → one-time prompt preface)', () => {
  function fakeSeam(
    over: Partial<typeof _agentStandardSeam> = {},
  ): typeof _agentStandardSeam {
    const marks = new Set<string>();
    return {
      isLocalSession: () => false,
      markerPath: (id: string) => `/marker/${id}`,
      exists: (p: string) => marks.has(p),
      write: (p: string) => {
        marks.add(p);
      },
      ...over,
    };
  }

  it('prepends the standard once for a non-Claude managed session', () => {
    const blocks: PromptBlock[] = [{ type: 'text', text: 'do the thing' }];
    maybePrefaceAgentStandard(blocks, 'codex', 's1', fakeSeam());
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: AGENT_STANDARD_TEXT });
    expect((blocks[1] as { text: string }).text).toContain('do the thing');
  });

  it('does not preface again once the session marker exists', () => {
    const seam = fakeSeam();
    const b1: PromptBlock[] = [{ type: 'text', text: 'first' }];
    maybePrefaceAgentStandard(b1, 'gemini', 's1', seam);
    const b2: PromptBlock[] = [{ type: 'text', text: 'second' }];
    maybePrefaceAgentStandard(b2, 'gemini', 's1', seam);
    expect(b1).toHaveLength(2);
    expect(b2).toHaveLength(1);
  });

  it('skips Claude (it gets the ~/.claude/CLAUDE.md file instead)', () => {
    const blocks: PromptBlock[] = [{ type: 'text', text: 'x' }];
    maybePrefaceAgentStandard(blocks, 'claude', 's1', fakeSeam());
    expect(blocks).toHaveLength(1);
  });

  it('skips local sessions (never touches a user-run CLI)', () => {
    const blocks: PromptBlock[] = [{ type: 'text', text: 'x' }];
    maybePrefaceAgentStandard(blocks, 'codex', 's1', fakeSeam({ isLocalSession: () => true }));
    expect(blocks).toHaveLength(1);
  });

  it('never throws and does not preface when the marker write fails', () => {
    const seam = fakeSeam({
      write: () => {
        throw new Error('read-only fs');
      },
    });
    const blocks: PromptBlock[] = [{ type: 'text', text: 'x' }];
    expect(() => maybePrefaceAgentStandard(blocks, 'codex', 's1', seam)).not.toThrow();
    expect(blocks).toHaveLength(1);
  });
});
