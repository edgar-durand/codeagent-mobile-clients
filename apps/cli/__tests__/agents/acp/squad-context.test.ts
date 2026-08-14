/**
 * Agent Squad — P2-0: native context delivery + the legacy-marker scrubber.
 *
 * The P0 (fleet-1, 2026-08-14): squad context rode the prompt as TEXT blocks,
 * so the agent's JSONL recorded it inside the user message and the hydration
 * path replayed `[Session handoff] You (Codex) are taking over…` as a visible
 * user bubble. The fix delivers it as ONE ACP `ContentBlock::Resource` and
 * scrubs the legacy markers out of already-written history.
 */
import { describe, it, expect } from 'vitest';
import {
  SQUAD_CONTEXT_URI,
  buildSquadContextBlock,
  isSquadContextBlock,
  looksLikeUnsupportedPromptShape,
  stripSquadContext,
} from '../../../src/agents/acp/squad-context';
import {
  buildDeltaBriefing,
  buildTeamPreamble,
  BRIEFING_FOOTER,
} from '../../../src/agents/acp/squad-roster';
import type { SquadRosterData } from '@codeam/shared';

const ROSTER: SquadRosterData = {
  agents: [
    { agentId: 'claude', displayName: 'Claude Code' },
    { agentId: 'codex', displayName: 'Codex CLI' },
  ],
  handoffsEnabled: true,
};

/** Verbatim copy of `buildHandoffPreamble`'s output shape (switch-agent.ts). */
const HANDOFF = [
  '[Session handoff] You (Codex CLI) are taking over a live coding session previously driven by Claude Code. ',
  'The conversation below is context from that session — continue the work seamlessly from where it left off. ',
  'Do not re-introduce yourself or re-do completed work.\n\n',
  '--- Recent conversation with Claude Code ---\n',
  'user: fix the parser\nagent: done\n',
  '--- End of handoff context ---',
].join('');

describe('buildSquadContextBlock', () => {
  it('produces the ACP EmbeddedResource shape on our own uri', () => {
    const block = buildSquadContextBlock('hello');
    expect(block).toEqual({
      type: 'resource',
      resource: { uri: 'codeam://squad-context', mimeType: 'text/plain', text: 'hello' },
    });
    expect(SQUAD_CONTEXT_URI).toBe('codeam://squad-context');
    expect(isSquadContextBlock(block)).toBe(true);
  });

  it('does not mistake a text or image block for squad context', () => {
    expect(isSquadContextBlock({ type: 'text', text: 'hi' })).toBe(false);
    expect(isSquadContextBlock({ type: 'image', mimeType: 'image/png', data: 'x' })).toBe(false);
    expect(
      isSquadContextBlock({
        type: 'resource',
        resource: { uri: 'file:///a.ts', mimeType: 'text/plain', text: 'x' },
      }),
    ).toBe(false);
  });
});

describe('looksLikeUnsupportedPromptShape', () => {
  it('accepts a JSON-RPC -32602 by code and by message', () => {
    expect(looksLikeUnsupportedPromptShape({ code: -32602, message: 'nope' })).toBe(true);
    expect(looksLikeUnsupportedPromptShape(new Error('Invalid params: prompt[0]'))).toBe(true);
    expect(looksLikeUnsupportedPromptShape(new Error('rpc error -32602'))).toBe(true);
  });

  it('accepts an explicit "resource … not supported" rejection', () => {
    expect(
      looksLikeUnsupportedPromptShape(new Error('content block type resource is not supported')),
    ).toBe(true);
  });

  it('REFUSES unrelated failures — a retry would double-run the turn', () => {
    expect(looksLikeUnsupportedPromptShape(new Error('ACP prompt idle'))).toBe(false);
    expect(looksLikeUnsupportedPromptShape(new Error('401 Invalid authentication'))).toBe(false);
    expect(looksLikeUnsupportedPromptShape({ code: -32603, message: 'internal' })).toBe(false);
    expect(looksLikeUnsupportedPromptShape(undefined)).toBe(false);
  });
});

describe('stripSquadContext', () => {
  it('returns byte-identical text when no marker is present', () => {
    const text = 'Just a normal prompt.\n\nWith a second paragraph.\n- and a bullet\n';
    expect(stripSquadContext(text)).toBe(text);
  });

  it('strips a handoff preamble that PRECEDES the user prompt', () => {
    expect(stripSquadContext(`${HANDOFF}\nnow the tests`)).toBe('now the tests');
  });

  it('strips a handoff preamble in the MIDDLE of a message', () => {
    expect(stripSquadContext(`before\n${HANDOFF}\nafter`)).toBe('before\nafter');
  });

  it('strips the real team preamble (with the PRO protocol lines)', () => {
    const preamble = buildTeamPreamble(ROSTER, 'claude', { handoffInstructions: true });
    expect(preamble).not.toBeNull();
    expect(stripSquadContext(`${preamble}\nship it`)).toBe('ship it');
  });

  it('strips the team preamble WITHOUT the protocol lines (FREE plan)', () => {
    const preamble = buildTeamPreamble(ROSTER, 'claude', { handoffInstructions: false });
    expect(stripSquadContext(`${preamble}\nship it`)).toBe('ship it');
  });

  it('strips the real delta briefing', () => {
    const briefing = buildDeltaBriefing([
      {
        turn: 1,
        agentId: 'claude',
        prompt: 'refactor the parser',
        replySummary: 'split into two modules',
        filesTouched: ['src/parser.ts'],
      },
    ]);
    expect(briefing).toContain(BRIEFING_FOOTER);
    expect(stripSquadContext(`${briefing}\nnow the tests`)).toBe('now the tests');
  });

  it('strips ALL THREE blocks composed in prompt order, leaving only the user text', () => {
    const preamble = buildTeamPreamble(ROSTER, 'codex', { handoffInstructions: true });
    const briefing = buildDeltaBriefing([
      {
        turn: 1,
        agentId: 'claude',
        prompt: 'wrote the parser',
        replySummary: 'parser done',
        filesTouched: [],
      },
    ]);
    const joined = [preamble, briefing, HANDOFF, 'now the tests'].join('\n');
    expect(stripSquadContext(joined)).toBe('now the tests');
  });

  it('strips MULTIPLE occurrences of the same marker', () => {
    const joined = `${HANDOFF}\nfirst\n${HANDOFF}\nsecond`;
    expect(stripSquadContext(joined)).toBe('first\nsecond');
  });

  it('leaves a marker with NO terminator untouched (never eat the user words)', () => {
    const clipped = '[Session handoff] You (Codex CLI) are taking over\nand my real question';
    expect(stripSquadContext(clipped)).toBe(clipped);
    const clippedBriefing = '[Team update] While you were away\nand my real question';
    expect(stripSquadContext(clippedBriefing)).toBe(clippedBriefing);
  });

  it('returns empty for a message that was ENTIRELY injected context', () => {
    expect(stripSquadContext(HANDOFF)).toBe('');
  });
});
