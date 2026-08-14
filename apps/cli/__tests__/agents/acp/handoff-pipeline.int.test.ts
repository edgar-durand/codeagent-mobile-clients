/**
 * End-to-end handoff pipeline verification (fake-based, no Docker) —
 * fleet-1 round-2. Drives the REAL runner machinery a live turn takes for an
 * agent-proposed handoff, parametrized over three wire-format variants: the
 * proper 3-backtick fence, the round-1 same-line degenerate form, and the
 * round-2 EXACT repro (codex, codeam-cli v2.65.4) — a tag-ALONE line
 * followed by the JSON on the next line — which evaded both prior nets in
 * production.
 *
 * Two layers are exercised, matching the ACTUAL two-stage pipeline a live
 * turn runs:
 *
 *   1. THE REAL COMMAND PIPELINE — `dispatchAcpCommand`/
 *      `assembleAcpCommandContext` (same harness shape as
 *      `start-task-routing.test.ts`'s `makeCtx`) drive the REAL `startTaskH`
 *      handler in `command-handlers.ts`: the REAL `extractHandoffProposal`
 *      call, the REAL `handoff_proposed` emission via the serialized
 *      squad-event emitter (`postSquadEvent`, captured here as a fake sink),
 *      and the REAL `history.appendAgentReply(cleanText)` durable write.
 *      This is the exact call chain the production bug (no card, raw
 *      litter, silently dropped explanatory text) traces through. The
 *      `streaming` object in this layer is a FAKE (`getCurrentText` /
 *      `closeTurnWithInteractiveDetection`) — it only proves the command
 *      pipeline's OWN wiring, not the published live/terminal bytes.
 *   2. THE REAL StreamingState — a real `AcpPublisher` (network methods
 *      spied, no POST leaves the process) + a real `StreamingState`
 *      instance (`runner.ts`) fed the SAME reply text via `.append()`
 *      deltas (mirroring real token-by-token streaming), then closed via
 *      the REAL `closeTurnWithInteractiveDetection()` — the exact function
 *      `runAcpSession` calls at turn close, which publishes the terminal
 *      chat-bubble frame mobile actually renders. This is what proves the
 *      LIVE user-visible bubble is clean, not just the durable history.
 *
 * If a full runner mount (spawning a real ACP adapter over stdio) were used
 * instead of these two fake-based layers, this is the exact sequence of
 * REAL functions it would drive at turn close, with the same inputs, in the
 * same order: `streaming.closeTurnWithInteractiveDetection()` (→
 * `visible()` → `stripHandoffFences()`) → `extractHandoffProposal(finalText,
 * opts.agent, handoffTargets(ctx))` → `history.appendAgentReply(cleanText)`
 * → `postSquadEvent('handoff_proposed', record)`. Both layers here drive
 * those SAME real functions; only the ACP adapter/PTY spawn is faked out.
 *
 * ⚠️ Live-frame behavior INTENTIONALLY DIFFERS by variant (documented, not a
 * bug — see `handoff-protocol.ts` `handoffFenceStartMasked`'s own doc
 * comment): the live-stream cut only recognizes the STRICT 3-backtick fence
 * open marker. The degenerate forms (same-line and trailing-block) are NOT
 * part of the live cut — they can only be confirmed once the whole
 * line/block has streamed in, so cutting speculatively risks truncating
 * ordinary prose. For those two variants the raw JSON MAY appear in
 * intermediate LIVE publishes; what MUST stay clean is the TERMINAL frame
 * (`closeTurnWithInteractiveDetection`'s `done:true`/`isFinal:true` publish)
 * — the one that persists and is what the user is actually left looking at.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  dispatchAcpCommand,
  assembleAcpCommandContext,
  type AcpSessionContext,
} from '../../../src/agents/acp/command-handlers';
import { StreamingState } from '../../../src/agents/acp/runner';
import { AcpPublisher } from '../../../src/agents/acp/publisher';
import { SquadState } from '../../../src/agents/acp/squad-roster';
import { HANDOFF_FENCE_TAG, type RemoteCommand, type SquadRosterData } from '@codeam/shared';

const ROSTER: SquadRosterData = {
  agents: [
    { agentId: 'codex', displayName: 'Codex CLI' },
    { agentId: 'claude', displayName: 'Claude Code' },
  ],
  handoffsEnabled: true,
};

const REASON = 'El usuario quiere continuar esta tarea con Claude Code.';
const PROMPT = 'Continúa desde el contexto actual.';
const JSON_BODY = JSON.stringify({ to: 'claude', reason: REASON, prompt: PROMPT });
const LEAD_IN = 'Voy a pasar esto a Claude.';

interface Variant {
  name: string;
  reply: string;
  /** Whether the raw JSON body may leak into an intermediate LIVE publish
   *  before the terminal frame closes — see the file-level doc comment. */
  liveMayLeak: boolean;
}

/** Split `s` into fixed-size chunks, newlines included — plain slicing so
 *  every byte (including `\n`) survives, unlike a `.`-based regex split. */
function chunkString(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

const VARIANTS: Variant[] = [
  {
    name: '3-backtick strict fence',
    reply: `${LEAD_IN}\n\n\`\`\`${HANDOFF_FENCE_TAG}\n${JSON_BODY}\n\`\`\``,
    liveMayLeak: false,
  },
  {
    name: 'round-1 same-line degenerate form (single-backtick inline code span)',
    reply: `${LEAD_IN}\n\n\`${HANDOFF_FENCE_TAG} ${JSON_BODY}\``,
    liveMayLeak: true,
  },
  {
    name: 'round-2 EXACT repro: trailing-BLOCK form (tag alone on one line, JSON on the next)',
    reply: `${LEAD_IN}\n\n\`${HANDOFF_FENCE_TAG}\n${JSON_BODY}`,
    liveMayLeak: true,
  },
];

// ─── Layer 1: the real command pipeline (dispatchAcpCommand → startTaskH) ──

function startTask(payload: Record<string, unknown>, id = 'cmd-1'): RemoteCommand {
  return {
    id,
    sessionId: 's1',
    pluginId: 'p1',
    type: 'start_task',
    payload,
    status: 'pending',
    createdAt: Date.now(),
  } as unknown as RemoteCommand;
}

function makeCommandPipelineCtx(replyText: string, homeDir: string) {
  const client = {
    prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
    cancel: vi.fn(async () => undefined),
    stop: vi.fn(),
  };
  const relay = { sendResult: vi.fn(async () => undefined) };
  const streaming = {
    beginTurn: vi.fn(async () => undefined),
    getCurrentText: vi.fn(() => replyText),
    hasVisibleProgress: vi.fn(() => false),
    closeTurnWithInteractiveDetection: vi.fn(async () => false),
    closeWithBubble: vi.fn(async () => undefined),
    closeAll: vi.fn(async () => undefined),
  };
  const history = {
    appendUserPrompt: vi.fn(),
    appendAgentReply: vi.fn(),
    flush: vi.fn(async () => undefined),
  };
  const squad = new SquadState({ sessionId: 's1', homeDir });
  squad.roster = ROSTER;
  const postSquadEvent = vi.fn(async (type: string, payload: Record<string, unknown>) => ({
    ok: true,
    type,
    payload,
  }));

  const session = {
    client,
    relay,
    acpSessionId: 'conv-1',
    streaming,
    opts: { agent: 'codex', sessionId: 's1', pluginId: 'p1' },
    history,
    jsonlHistory: {},
    agentCaps: { loadSession: true },
    turnFiles: {
      flushTurn: vi.fn(async () => undefined),
      peekTurnPaths: vi.fn(() => []),
    },
    getBeads: () => null,
    publisher: { publishOutput: vi.fn(async () => undefined) },
    recentStderr: [],
    budgetRecovery: { offer: vi.fn(), tryRecover: vi.fn(async () => false) },
    budgetReachedFlag: { get: () => false, set: () => undefined },
    squad,
    routeToAgent: vi.fn(),
    pendingProposal: { current: null },
    postSquadEvent,
    pendingHandoff: undefined,
  } as unknown as AcpSessionContext;

  return { session, history, relay, postSquadEvent };
}

describe.each(VARIANTS)('handoff pipeline — $name', (variant) => {
  it('layer 1 (real command pipeline): emits handoff_proposed with to=claude, and the durable text carries NO litter', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-handoff-pipeline-'));
    try {
      const { session, history, postSquadEvent } = makeCommandPipelineCtx(variant.reply, dir);
      await dispatchAcpCommand(
        assembleAcpCommandContext(session, startTask({ prompt: 'ship it' })),
      );

      // (a) handoff_proposed emitted with the resolved runtime id.
      const proposedCalls = (
        postSquadEvent as unknown as { mock: { calls: Array<[string, Record<string, unknown>]> } }
      ).mock.calls.filter(([type]) => type === 'handoff_proposed');
      expect(proposedCalls).toHaveLength(1);
      expect(proposedCalls[0][1]).toMatchObject({
        fromAgentId: 'codex',
        toAgentId: 'claude',
        reason: REASON,
        prompt: PROMPT,
      });
      expect(session.pendingProposal?.current).toMatchObject({ toAgentId: 'claude' });

      // (b) the durable/published terminal text (what history persists, and
      // what a resumed session re-hydrates) contains NO codeam-handoff litter.
      const durableText = (
        history.appendAgentReply as unknown as { mock: { calls: Array<[string]> } }
      ).mock.calls[0][0];
      expect(durableText).toBe(LEAD_IN);
      expect(durableText).not.toContain(HANDOFF_FENCE_TAG);
      expect(durableText).not.toContain('"to"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('layer 2 (real StreamingState + real AcpPublisher): the TERMINAL frame is always clean; live frames per the documented rule', () => {
    const publisher = new AcpPublisher({
      sessionId: 'sess-1',
      pluginId: 'plugin-1',
      pluginAuthToken: 'tok-1',
      apiBaseUrl: 'https://api.example.test',
    });
    const publishOutput = vi.spyOn(publisher, 'publishOutput').mockResolvedValue(undefined);
    const publishStreamingChunk = vi
      .spyOn(publisher, 'publishStreamingChunk')
      .mockResolvedValue(undefined);
    const state = new StreamingState(publisher);

    // Stream the reply as several fixed-size deltas — mirrors real
    // token-by-token arrival rather than one atomic chunk. (Plain slicing,
    // NOT a `.`-based regex split — `.` doesn't match `\n` without the `s`
    // flag, so a regex split would silently drop the newlines that are
    // load-bearing for the trailing-block variant.)
    for (const part of chunkString(variant.reply, 17)) {
      state.append({ chunkId: 'msg-1', kind: 'text', delta: part });
    }

    // (c) live frames: assert per the documented rule for this variant.
    const liveTexts = publishOutput.mock.calls
      .map((c) => c[0] as { content?: unknown })
      .filter((b): b is { content: string } => typeof b.content === 'string');
    const anyLiveLeak = liveTexts.some(
      (b) => b.content.includes(HANDOFF_FENCE_TAG) || b.content.includes('"to"'),
    );
    if (variant.liveMayLeak) {
      // Documented, not a regression: the degenerate forms are outside the
      // live-cut's detection (see handoffFenceStartMasked's own doc
      // comment) — some intermediate live publish DOES carry the raw JSON
      // until the terminal frame closes and strips it.
      expect(anyLiveLeak).toBe(true);
    } else {
      expect(anyLiveLeak).toBe(false);
    }

    publishOutput.mockClear();
    publishStreamingChunk.mockClear();

    return (state as unknown as { closeTurnWithInteractiveDetection: () => Promise<boolean> })
      .closeTurnWithInteractiveDetection()
      .then(() => {
        // The TERMINAL frame — done:true / isFinal:true, the one that
        // PERSISTS and is what the user is left looking at — must be clean
        // for EVERY variant, including the two where live frames may leak.
        const terminalOutputs = publishOutput.mock.calls
          .map((c) => c[0] as { done?: boolean; content?: unknown })
          .filter((b) => b.done === true && typeof b.content === 'string') as Array<{
          content: string;
        }>;
        const terminalChunks = publishStreamingChunk.mock.calls
          .map((c) => c[0] as { isFinal?: boolean; content?: unknown })
          .filter((b) => b.isFinal === true && typeof b.content === 'string') as Array<{
          content: string;
        }>;
        expect(terminalOutputs.length).toBeGreaterThan(0);
        expect(terminalChunks.length).toBeGreaterThan(0);
        for (const frame of [...terminalOutputs, ...terminalChunks]) {
          expect(frame.content).not.toContain(HANDOFF_FENCE_TAG);
          expect(frame.content).not.toContain('"to"');
          expect(frame.content).not.toContain(PROMPT);
          expect(frame.content.trim()).toBe(LEAD_IN);
        }
      });
  });
});
