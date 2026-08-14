/**
 * Unit tests for Agent Squad roster state — journal persistence, member
 * defaults, the team preamble (handoff-gated), and the delta briefing
 * (newest-first trim, chronological render).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  SquadState,
  buildTeamPreamble,
  buildDeltaBriefing,
  TEAM_PREAMBLE_BULLET_RE,
} from '../../../src/agents/acp/squad-roster';

const ROSTER = {
  agents: [
    { agentId: 'claude', displayName: 'Claude Code' },
    { agentId: 'codex', displayName: 'Codex' },
  ],
  handoffsEnabled: true,
};

// ─── buildTeamPreamble ────────────────────────────────────────────────────────

describe('buildTeamPreamble', () => {
  it('lists only the OTHER members with their specialties', () => {
    const p = buildTeamPreamble(ROSTER, 'claude', { handoffInstructions: false })!;
    expect(p).toContain('Codex');
    expect(p).not.toMatch(/alongside[^]*Claude Code/);
    expect(p).not.toContain('codeam-handoff');
  });

  it('includes the handoff protocol only when entitled', () => {
    const p = buildTeamPreamble(ROSTER, 'claude', { handoffInstructions: true })!;
    expect(p).toContain('codeam-handoff');
    expect(p).toContain('"to"');
  });

  it('returns null for a single-member roster', () => {
    expect(
      buildTeamPreamble({ agents: [ROSTER.agents[0]], handoffsEnabled: true }, 'claude', {
        handoffInstructions: true,
      }),
    ).toBeNull();
  });

  it('stays under the 2KB budget', () => {
    const p = buildTeamPreamble(ROSTER, 'claude', { handoffInstructions: true })!;
    expect(p.length).toBeLessThanOrEqual(2000);
  });

  it('falls back to a generic blurb for an agent id with no known specialty', () => {
    const roster = {
      agents: [
        { agentId: 'claude', displayName: 'Claude Code' },
        { agentId: 'some-future-agent', displayName: 'Future Agent' },
      ],
      handoffsEnabled: false,
    };
    const p = buildTeamPreamble(roster, 'claude', { handoffInstructions: false })!;
    expect(p).toContain('Future Agent');
    expect(p).toContain('general implementation tasks');
  });

  // ─── Preamble hardening — fleet-1 codex-emitted-"Claude Code" incident ──────

  it('lists the RUNTIME id inline on every teammate bullet, not just the display name', () => {
    const p = buildTeamPreamble(ROSTER, 'claude', { handoffInstructions: false })!;
    expect(p).toContain('- Codex (id: codex) — best at:');
  });

  it('the handoff instructions spell out the strict three-backtick fence requirement', () => {
    const p = buildTeamPreamble(ROSTER, 'claude', { handoffInstructions: true })!;
    expect(p).toContain('three-backtick');
    expect(p).toContain('never a single backtick, never bare text');
    expect(p).toContain('```' + 'codeam-handoff');
  });

  it('the handoff instructions tell the agent to use the id verbatim, not the display name', () => {
    const p = buildTeamPreamble(ROSTER, 'claude', { handoffInstructions: true })!;
    expect(p).toContain('EXACTLY as shown');
    expect(p).toContain('never');
    expect(p).toContain('"Claude Code"');
  });

  it('teammate bullets still match TEAM_PREAMBLE_BULLET_RE (squad-context scrubbing depends on it)', () => {
    const p = buildTeamPreamble(ROSTER, 'claude', { handoffInstructions: true })!;
    const bulletLine = p.split('\n').find((l) => l.startsWith('- Codex'));
    expect(bulletLine).toBeDefined();
    expect(TEAM_PREAMBLE_BULLET_RE.test(bulletLine!)).toBe(true);
  });
});

// ─── buildDeltaBriefing ───────────────────────────────────────────────────────

describe('buildDeltaBriefing', () => {
  const entry = (turn: number, agentId: string) => ({
    turn,
    agentId,
    prompt: `do thing ${turn}`,
    replySummary: `did thing ${turn}`,
    filesTouched: ['a.ts'],
  });

  it('renders chronologically and names the acting agent + files', () => {
    const b = buildDeltaBriefing([entry(1, 'codex'), entry(2, 'codex')])!;
    expect(b.indexOf('thing 1')).toBeLessThan(b.indexOf('thing 2'));
    expect(b).toContain('codex');
    expect(b).toContain('a.ts');
  });

  it('trims newest-first to the cap', () => {
    const many = Array.from({ length: 200 }, (_, i) => entry(i, 'codex'));
    const b = buildDeltaBriefing(many, 500)!;
    expect(b.length).toBeLessThanOrEqual(600); // cap + envelope
    expect(b).toContain('thing 199'); // newest survives
  });

  it('returns null for no entries', () => {
    expect(buildDeltaBriefing([])).toBeNull();
  });
});

// ─── SquadState ───────────────────────────────────────────────────────────────

describe('SquadState', () => {
  it('persists the journal across instances (CLI restart)', () => {
    const home = mkdtempSync(join(tmpdir(), 'squad-'));
    const a = new SquadState({ sessionId: 's1', homeDir: home });
    a.recordTurn({ agentId: 'claude', prompt: 'p', replySummary: 'r', filesTouched: [] });
    const b = new SquadState({ sessionId: 's1', homeDir: home });
    expect(b.turnCount()).toBe(1);
    expect(b.entriesSince(0)[0]).toMatchObject({ agentId: 'claude', turn: 1 });
  });

  it('member() defaults and mutates in place', () => {
    const s = new SquadState({ sessionId: 's2', homeDir: mkdtempSync(join(tmpdir(), 'squad-')) });
    expect(s.member('codex')).toMatchObject({
      provisioned: false,
      acpSessionId: null,
      lastTurnIndex: 0,
    });
    s.member('codex').provisioned = true;
    expect(s.member('codex').provisioned).toBe(true);
  });

  it('survives a corrupt journal file', () => {
    const home = mkdtempSync(join(tmpdir(), 'squad-'));
    const dir = join(home, '.codeam');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'squad-journal-s3.json'), '{ not valid json');
    const s = new SquadState({ sessionId: 's3', homeDir: home });
    expect(s.turnCount()).toBe(0);
  });

  it('trims prompt and replySummary to their caps on write', () => {
    const home = mkdtempSync(join(tmpdir(), 'squad-'));
    const s = new SquadState({ sessionId: 's4', homeDir: home });
    s.recordTurn({
      agentId: 'codex',
      prompt: 'p'.repeat(600),
      replySummary: 'r'.repeat(1200),
      filesTouched: [],
    });
    const [written] = s.entriesSince(0);
    expect(written.prompt.length).toBe(500);
    expect(written.replySummary.length).toBe(1000);
  });

  it('entriesSince returns only entries after the given turn index', () => {
    const home = mkdtempSync(join(tmpdir(), 'squad-'));
    const s = new SquadState({ sessionId: 's5', homeDir: home });
    s.recordTurn({ agentId: 'claude', prompt: 'p1', replySummary: 'r1', filesTouched: [] });
    s.recordTurn({ agentId: 'codex', prompt: 'p2', replySummary: 'r2', filesTouched: [] });
    s.recordTurn({ agentId: 'claude', prompt: 'p3', replySummary: 'r3', filesTouched: [] });
    expect(s.entriesSince(1).map((e) => e.turn)).toEqual([2, 3]);
  });

  it('roster starts null and can be assigned', () => {
    const s = new SquadState({ sessionId: 's6', homeDir: mkdtempSync(join(tmpdir(), 'squad-')) });
    expect(s.roster).toBeNull();
    s.roster = ROSTER;
    expect(s.roster).toBe(ROSTER);
  });
});
