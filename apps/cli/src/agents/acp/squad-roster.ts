/**
 * Agent Squad — roster state, journal persistence, team preamble, and delta
 * briefing. Pure core: no relay/ACP wiring here (that's Task 6's
 * runner.ts/command-handlers.ts), just the state machine + copy-generation
 * pieces the runner injects into a live turn.
 *
 *   - `SquadState` tracks per-agent provisioning/session state for the
 *     session's squad AND a journal of what every agent did, persisted to
 *     `~/.codeam/squad-journal-<sessionId>.json` so a CLI restart doesn't
 *     lose the team's shared history.
 *   - `buildTeamPreamble` is prefixed once per agent activation — tells the
 *     active agent who else is on the squad (and, when the plan allows,
 *     how to propose a handoff via the `codeam-handoff` fenced block).
 *   - `buildDeltaBriefing` is prefixed to a turn when OTHER agents made
 *     journal entries the active agent hasn't seen yet — "here's what
 *     happened while you were away."
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  HANDOFF_FENCE_TAG,
  SQUAD_HOP_BUDGET_DEFAULT,
  SQUAD_SPECIALTIES,
  clampHopBudget,
  type SquadAutoConfig,
  type SquadMemberActivity,
  type SquadRosterData,
  type SquadStatsResult,
} from '@codeam/shared';

export interface SquadMemberState {
  /** The agent's OWN conversation id, for --resume via loadSession. */
  acpSessionId: string | null;
  /** Credential already delivered this CLI process. */
  provisioned: boolean;
  binaryVerified: boolean;
  /** Last journal turn this agent has seen (drives `entriesSince`). */
  lastTurnIndex: number;
  /**
   * This agent's ACP adapter rejected a `ContentBlock::Resource` prompt block
   * (invalid-params), so squad context is delivered to it as legacy TEXT
   * blocks for the rest of the session. Set by the ONE retry in
   * `startTaskH`; never unset (an adapter's capability doesn't change
   * mid-process).
   */
  contextTextFallback: boolean;
}

export interface SquadJournalEntry {
  turn: number;
  agentId: string;
  /** Trimmed to 500 chars on write. */
  prompt: string;
  /** Trimmed to 1000 chars on write. */
  replySummary: string;
  filesTouched: string[];
}

const PROMPT_MAX = 500;
const REPLY_SUMMARY_MAX = 1000;
const PREAMBLE_MAX = 2000;
const BRIEFING_DEFAULT_MAX = 8000;

/** Blurb for an agent id with no entry in SQUAD_SPECIALTIES (a future agent). */
const GENERIC_SPECIALTY = 'general implementation tasks';

interface JournalFile {
  turns: SquadJournalEntry[];
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function defaultMember(): SquadMemberState {
  return {
    acpSessionId: null,
    provisioned: false,
    binaryVerified: false,
    lastTurnIndex: 0,
    contextTextFallback: false,
  };
}

function journalPathFor(homeDir: string, sessionId: string): string {
  return path.join(homeDir, '.codeam', `squad-journal-${sessionId}.json`);
}

function loadJournal(journalPath: string): SquadJournalEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as JournalFile;
    return Array.isArray(raw.turns) ? raw.turns : [];
  } catch {
    // Missing or corrupt file → start with an empty journal.
    return [];
  }
}

export class SquadState {
  /** Set by the caller after fetchSquadRoster; null until then. */
  roster: SquadRosterData | null = null;

  /**
   * Autonomous chained handoffs (P2-2, PRO). Seeded from the persisted
   * `SavedSession.squadAuto` at session start and rewritten by
   * `squad_configure`. Read-only to callers — mutate via {@link setAuto}, which
   * clamps the budget and re-arms the chain.
   */
  private autoConfig: SquadAutoConfig = { enabled: false, hopBudget: SQUAD_HOP_BUDGET_DEFAULT };

  /**
   * Hops left in the CURRENT chain. Reset to the budget on every USER-initiated
   * prompt (so a user turn always interrupts and re-arms) and decremented by
   * each self-accepted handoff.
   */
  private hopsLeft = 0;

  /** Lifetime handoff counters for `squad_stats` (in-memory, this process). */
  private readonly handoffCounters = { proposed: 0, accepted: 0, auto: 0 };

  private readonly journalPath: string;
  private turns: SquadJournalEntry[];
  private readonly members = new Map<string, SquadMemberState>();

  constructor(opts: { sessionId: string; homeDir?: string; auto?: SquadAutoConfig | null }) {
    this.journalPath = journalPathFor(opts.homeDir ?? os.homedir(), opts.sessionId);
    this.turns = loadJournal(this.journalPath);
    if (opts.auto) this.setAuto(opts.auto);
  }

  get auto(): Readonly<SquadAutoConfig> {
    return this.autoConfig;
  }

  /** Apply a new mode (clamping the budget) and re-arm the chain. */
  setAuto(value: SquadAutoConfig): SquadAutoConfig {
    this.autoConfig = {
      enabled: value.enabled === true,
      hopBudget: clampHopBudget(value.hopBudget),
    };
    this.resetHops();
    return this.autoConfig;
  }

  hopsRemaining(): number {
    return this.hopsLeft;
  }

  /** Re-arm the chain — called at the start of every USER-initiated turn. */
  resetHops(): void {
    this.hopsLeft = this.autoConfig.enabled ? this.autoConfig.hopBudget : 0;
  }

  /** Spend one hop on a self-accepted handoff. */
  consumeHop(): void {
    if (this.hopsLeft > 0) this.hopsLeft -= 1;
  }

  countProposal(opts: { auto: boolean }): void {
    this.handoffCounters.proposed += 1;
    if (opts.auto) this.handoffCounters.auto += 1;
  }

  countAccepted(): void {
    this.handoffCounters.accepted += 1;
  }

  /**
   * Per-member activity for the `squad_stats` relay command, derived from the
   * journal (the same shared history the delta briefing reads) plus the
   * in-memory handoff counters. `filesTouched` counts DISTINCT paths — a member
   * that edited the same file across three turns touched ONE file.
   */
  stats(): SquadStatsResult {
    const byAgent = new Map<string, { turns: number; files: Set<string> }>();
    for (const t of this.turns) {
      let row = byAgent.get(t.agentId);
      if (!row) {
        row = { turns: 0, files: new Set() };
        byAgent.set(t.agentId, row);
      }
      row.turns += 1;
      for (const f of t.filesTouched) row.files.add(f);
    }
    const members: SquadMemberActivity[] = [...byAgent.entries()].map(([agentId, row]) => ({
      agentId,
      turns: row.turns,
      filesTouched: row.files.size,
    }));
    return { members, handoffs: { ...this.handoffCounters }, sinceTurn: 1 };
  }

  /** Returns (creating on first access) the mutable per-agent state. */
  member(agentId: string): SquadMemberState {
    let m = this.members.get(agentId);
    if (!m) {
      m = defaultMember();
      this.members.set(agentId, m);
    }
    return m;
  }

  /** Appends a journal entry and persists (fire-and-forget durability). */
  recordTurn(entry: Omit<SquadJournalEntry, 'turn'>): void {
    const turn: SquadJournalEntry = {
      turn: this.turns.length + 1,
      agentId: entry.agentId,
      prompt: clip(entry.prompt, PROMPT_MAX),
      replySummary: clip(entry.replySummary, REPLY_SUMMARY_MAX),
      filesTouched: entry.filesTouched,
    };
    this.turns.push(turn);
    this.persist();
  }

  turnCount(): number {
    return this.turns.length;
  }

  entriesSince(turnIndex: number): SquadJournalEntry[] {
    return this.turns.filter((t) => t.turn > turnIndex);
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.journalPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.journalPath, JSON.stringify({ turns: this.turns }), { mode: 0o600 });
    } catch {
      // Fire-and-forget durability — a failed write never blocks a turn;
      // worst case the journal picks back up from the in-memory state.
    }
  }
}

function specialtyFor(agentId: string): string {
  return SQUAD_SPECIALTIES[agentId as keyof typeof SQUAD_SPECIALTIES] ?? GENERIC_SPECIALTY;
}

/**
 * Every literal line of the team preamble that is NOT a per-teammate bullet.
 * Exported (and consumed by {@link buildTeamPreamble} itself) so
 * `stripSquadContext` has ONE source of truth for the block's extent when it
 * scrubs a legacy text-delivered preamble out of hydrated history — a
 * hand-copied list there would silently rot the moment this copy changes.
 */
export const TEAM_PREAMBLE_MARKER = '[Team context]';
export const TEAM_PREAMBLE_LINES: readonly string[] = [
  '[Team context] You are the active agent in a CodeAgent Mobile session where the user',
  'has a squad of agents and can pass work between them. Your available teammates:',
  'If a task clearly fits a teammate better than you, you MAY propose a handoff. The fence',
  `MUST be a three-backtick code block with the info string exactly ${HANDOFF_FENCE_TAG}`,
  '(never a single backtick, never bare text) with the JSON alone on its own line inside',
  'it, exactly like this:',
  '```' + HANDOFF_FENCE_TAG,
  '{"to":"<teammate id>","reason":"<one sentence>","prompt":"<the prompt they should run>"}',
  '```',
  '"to" MUST be one of the ids shown above, written EXACTLY as shown (e.g. "claude", never',
  'a display name like "Claude Code"). Propose at most one handoff per reply, only when',
  'genuinely better, and never announce the block in prose — the app renders it as a card',
  'the user can accept.',
];
/** Shape of a teammate bullet — the only VARIABLE lines in the preamble
 * (each now also carries the literal id the agent must use for "to"). */
export const TEAM_PREAMBLE_BULLET_RE = /^- .+ — best at: /;

export const BRIEFING_MARKER = '[Team update]';
export const BRIEFING_HEADER =
  '[Team update] While you were away, other agents worked on this session:';
/** Last line of a delta briefing — the block's stable terminator. */
export const BRIEFING_FOOTER = 'Continue from the CURRENT state of the working tree.';

/**
 * The one-time-per-activation preamble telling the active agent who else is
 * on the squad. Returns null when the roster has no OTHER member (nothing
 * useful to say). `handoffInstructions` gates the codeam-handoff protocol
 * paragraph — PRO-only, decided by the caller.
 */
export function buildTeamPreamble(
  roster: SquadRosterData,
  currentAgent: string,
  opts: { handoffInstructions: boolean },
): string | null {
  const others = roster.agents.filter((a) => a.agentId !== currentAgent);
  if (others.length === 0) return null;

  const lines = [
    TEAM_PREAMBLE_LINES[0],
    TEAM_PREAMBLE_LINES[1],
    ...others.map(
      (a) => `- ${a.displayName} (id: ${a.agentId}) — best at: ${specialtyFor(a.agentId)}`,
    ),
  ];

  if (opts.handoffInstructions) {
    lines.push(...TEAM_PREAMBLE_LINES.slice(2));
  }

  return clip(lines.join('\n'), PREAMBLE_MAX);
}

function renderJournalEntry(e: SquadJournalEntry): string {
  const filesClause = e.filesTouched.length > 0 ? ` (files: ${e.filesTouched.join(', ')})` : '';
  return `- turn ${e.turn} (${e.agentId}): ${e.prompt} → ${e.replySummary}${filesClause}`;
}

/**
 * "While you were away" briefing prefixed to a turn when other agents made
 * journal entries the active agent hasn't seen. Trims newest-first to
 * `maxChars` (so the most recent work always survives a long journal) then
 * renders the surviving entries chronologically. Null for no entries.
 */
export function buildDeltaBriefing(
  entries: SquadJournalEntry[],
  maxChars: number = BRIEFING_DEFAULT_MAX,
): string | null {
  if (entries.length === 0) return null;

  const header = BRIEFING_HEADER;
  const footer = BRIEFING_FOOTER;
  const envelope = header.length + 1 + footer.length + 1;

  const sorted = [...entries].sort((a, b) => a.turn - b.turn);
  const lines: string[] = [];
  let bodyLen = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const line = renderJournalEntry(sorted[i]);
    const addedLen = line.length + (lines.length > 0 ? 1 : 0);
    if (lines.length > 0 && envelope + bodyLen + addedLen > maxChars) break;
    lines.unshift(line);
    bodyLen += addedLen;
  }

  return [header, lines.join('\n'), footer].join('\n');
}
