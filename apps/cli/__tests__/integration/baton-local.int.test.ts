/**
 * Session Baton — REAL local-session integration test.
 *
 * This is NOT a unit test. It runs the actual composition root
 * (`runBatonSession`) with the REAL native `claude` TUI, the REAL ACP adapter,
 * the REAL `CommandRelayService`, controller, drivers and transcript mirror,
 * against a LOCAL STUB BACKEND (an in-process HTTP server that serves the
 * pairing/relay endpoints and captures everything the CLI posts). Only the
 * backend is faked — nothing in `src/` is mocked.
 *
 * It reproduces, end to end, the bugs the owner hit on 2026-08-18:
 *
 *   1. **Take Control before the first TUI turn.** The native driver pre-mints
 *      the conversation id at spawn, but claude writes `<id>.jsonl` only on its
 *      first turn — so `session/load` for that id never resolved and the baton
 *      sat in `SWITCHING` forever. Asserted: `MOBILE_DRIVE` lands (and the state
 *      is not stuck on `SWITCHING`).
 *   2. **Take Control AFTER a real turn exists on disk.** The other branch of
 *      the same guard (`AcpDriver.hasTranscript` → `session/load`), asserted
 *      only once a `<id>.jsonl` is verifiably on disk — so a regression that
 *      "fixes" the zero-turn case by never loading at all still fails here.
 *   3. **Handback.** After a real ACP turn from "mobile", the baton returns to
 *      `LOCAL_DRIVE` on the same conversation.
 *   4. **No screen-scrape in LOCAL_DRIVE.** Not one `/api/commands/output`
 *      frame carries raw TUI chrome (box drawing, `❯`, "shift+tab to cycle").
 *   5. **Goodbye heartbeat.** SIGINT posts `online:false` BEFORE the process
 *      exits, so mobile stops showing the session as online.
 *
 * A second scenario (2026-08-19) proves the mobile keeps FOLLOWING the native
 * TUI through `/clear` (new conversation id) and `/rename` — see the doc on
 * that test below.
 *
 * ── Gating / auth ────────────────────────────────────────────────────────
 * See `__tests__/fixtures/baton/local-harness.ts` (`RUN_BATON_INT=1`; skips
 * locally without a claude backend, FAILS LOUDLY in CI).
 *
 * ⚠️ `process.exit` is stubbed for the duration (the CLI's shutdown paths call
 * it), which is also what lets the goodbye assertion observe the ORDER: the
 * exit spy records whether the offline heartbeat had already landed when it
 * fired.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  RUN_BATON_INT,
  IN_CI,
  BLOCKED,
  CHROME_MARKERS,
  announceGate,
  preflight,
  startStubBackend,
  type StubBackend,
  waitUntil,
  transcriptIds,
  transcriptRaw,
  makeSessionCwd,
} from '../fixtures/baton/local-harness';

announceGate('baton-local');

const RENAMED_TITLE = 'codeam-baton-clear-int';

/**
 * CI must never silently skip this gate. When the environment can't run it we
 * still register a test — one that fails with the precise reason — so the step
 * is red and attributable instead of green-and-hollow.
 */
describe.runIf(RUN_BATON_INT && IN_CI && BLOCKED !== null)(
  'session baton — real local session (claude): CI preflight',
  () => {
    it('has an authenticated claude available (this gate must not skip in CI)', () => {
      throw new Error(
        `[baton-local] CI GATE CANNOT RUN — ${BLOCKED}\n` +
          'Fix the runner provisioning (see .github/workflows/ci.yml, step "Provision the house agent") ' +
          'rather than letting this gate skip.',
      );
    });
  },
);

describe.skipIf(!RUN_BATON_INT || BLOCKED !== null)('session baton — real local session (claude)', () => {
  // One stub backend for the whole file (see `startStubBackend`): the CLI
  // captures the API base at module import, so every scenario must post to
  // the SAME port. Each scenario `reset()`s what it recorded.
  let backend: StubBackend;
  beforeAll(async () => {
    preflight('baton-local');
    backend = await startStubBackend();
  }, 300_000);
  afterAll(async () => {
    await backend?.close();
  });

  it('take-control BEFORE the first turn AND after one on disk → MOBILE_DRIVE both times, handback → LOCAL_DRIVE, no TUI bytes in chat, goodbye on SIGINT', async () => {
    const exits: Array<{ code: number | undefined; sawOffline: boolean }> = [];
    backend.reset();
    const { rec, enqueue, lastState, sawOffline } = backend;

    const cwd = makeSessionCwd();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits.push({ code, sawOffline: sawOffline() });
      return undefined as never;
    }) as typeof process.exit);

    const { runBatonSession } = await import('../../src/baton/wire-baton');
    const { getAcpAdapter } = await import('../../src/agents/acp/adapters');
    const adapter = getAcpAdapter('claude');
    if (!adapter) throw new Error('claude ACP adapter not resolvable');

    const sessionId = `baton-int-${randomUUID()}`;
    const pluginId = `plugin-${randomUUID()}`;

    try {
      // Blocks forever by design — run it in the background.
      void runBatonSession({
        agent: 'claude',
        sessionId,
        pluginId,
        pluginAuthToken: 'int-token',
        cwd,
        adapter,
      }).catch((err) => {
        // Surfaced by the assertions below (the state simply never arrives).
        // eslint-disable-next-line no-console
        console.error('[baton-local] runBatonSession threw:', err);
      });

      // 1. The baton comes up driving locally.
      await waitUntil(
        'baton_state LOCAL_DRIVE',
        () => rec.batonEvents.some((e) => e.state === 'LOCAL_DRIVE'),
        90_000,
      );

      // 2. ── BRANCH A: Take Control with ZERO turns on this conversation ──
      //    The exact owner scenario. The native driver pre-minted the id at
      //    spawn and claude has not written `<id>.jsonl` yet, so `session/load`
      //    has nothing to load — `AcpDriver` must mint a FRESH ACP session
      //    instead of hanging. Let the TUI finish booting first (it must be
      //    genuinely up, just turn-less), then hand over.
      await new Promise((r) => setTimeout(r, 12_000));
      expect(
        transcriptIds(cwd),
        'BRANCH A precondition: claude must not have written a transcript yet',
      ).toEqual([]);
      enqueue({ id: 'cmd-take-1', sessionId, type: 'take_control', payload: {} });
      await waitUntil(
        'baton_state MOBILE_DRIVE (branch A: zero turns — not stuck in SWITCHING)',
        () => lastState() === 'MOBILE_DRIVE',
        120_000,
      );

      // 3. A real turn from "mobile" over ACP, so the conversation actually
      //    exists on disk for the handback to resume.
      enqueue({
        id: 'cmd-task',
        sessionId,
        type: 'start_task',
        payload: { prompt: 'Reply with the single word OK.' },
      });
      await waitUntil(
        'the ACP turn to complete',
        () => rec.results.some((r) => r.commandId === 'cmd-task'),
        180_000,
      );

      // 4. Handback returns the baton to the terminal.
      enqueue({ id: 'cmd-back-1', sessionId, type: 'handback', payload: {} });
      await waitUntil(
        'baton_state LOCAL_DRIVE again',
        () => lastState() === 'LOCAL_DRIVE',
        120_000,
      );

      // 5. A prompt sent from mobile WHILE the terminal holds the baton. This
      //    is what used to open a legacy PTY turn and pump the native TUI's
      //    raw frames into the chat pipe (assertion 8 below) — the mobile view
      //    in LOCAL_DRIVE must come from the transcript mirror alone. It also
      //    puts a NATIVE-TUI-authored turn on disk for branch B.
      enqueue({
        id: 'cmd-local-task',
        sessionId,
        type: 'start_task',
        payload: { prompt: 'Reply with the single word PING.' },
      });
      // Well past OutputService's 1.5 s warm-up + several 1 s render ticks, so
      // any screen-scraped frame would already have been posted.
      await new Promise((r) => setTimeout(r, 20_000));

      // 6. ── BRANCH B: Take Control with a transcript ON DISK ──────────────
      //    The other side of the same guard: `hasTranscript` is true, so the
      //    driver goes through `session/load` (and must swallow its replay
      //    rather than wedge mobile's "Thinking…"). Asserted only once the
      //    JSONL is verifiably there, so a regression that never loads at all
      //    cannot pass this by accident.
      await waitUntil(
        "claude's transcript JSONL to exist on disk (branch B precondition)",
        () => transcriptIds(cwd).length > 0,
        180_000,
      );
      enqueue({ id: 'cmd-take-2', sessionId, type: 'take_control', payload: {} });
      await waitUntil(
        'baton_state MOBILE_DRIVE (branch B: session/load over an existing transcript)',
        () => lastState() === 'MOBILE_DRIVE',
        120_000,
      );

      // 7. …and back to the terminal one more time.
      enqueue({ id: 'cmd-back-2', sessionId, type: 'handback', payload: {} });
      await waitUntil(
        'baton_state LOCAL_DRIVE after the second handback',
        () => lastState() === 'LOCAL_DRIVE',
        120_000,
      );

      // 8. Not one chat frame carries raw TUI chrome — LOCAL_DRIVE mirrors
      //    the transcript, it never screen-scrapes.
      const chromeFrames = rec.outputFrames.filter((f) => {
        const text = typeof f.content === 'string' ? f.content : '';
        return CHROME_MARKERS.some((m) => text.includes(m));
      });
      expect(
        chromeFrames.map((f) => String(f.content).slice(0, 120)),
        'raw TUI chrome leaked into the chat pipe',
      ).toEqual([]);

      // 9. Ctrl+C says goodbye BEFORE exiting.
      process.emit('SIGINT');
      await waitUntil(
        'an exit that happened AFTER the online:false heartbeat',
        () => exits.some((e) => e.code === 0 && e.sawOffline),
        30_000,
      );
      expect(sawOffline()).toBe(true);
    } finally {
      exitSpy.mockRestore();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 900_000);

  /**
   * ── /clear + /rename follow-through (owner report 2026-08-18) ────────────
   * On a local baton session the owner ran `/clear` then `/rename` in the
   * Claude Code TUI and the mobile stopped receiving the streamed turns.
   * Verified live (claude 2.1.235, 2026-08-19): `/clear` mints a NEW session
   * id and immediately writes `<newId>.jsonl`; the old file is never touched
   * again — so the transcript mirror kept tailing a dead file and Take Control
   * `session/load`ed the old id. `/rename` only appends `custom-title` records
   * to the current file. Asserted end to end:
   *   1. a TUI turn BEFORE `/clear` is mirrored live to mobile;
   *   2. `/clear` → the baton re-publishes LOCAL_DRIVE with the NEW
   *      conversation id (the one claude actually created);
   *   3. `/rename` → no spurious switch; the mirror keeps working;
   *   4. a TUI turn AFTER `/clear` + `/rename` is mirrored live AND lands in a
   *      conversation snapshot keyed by the NEW id — and no `<command-name>`
   *      slash-command echo leaks into the chat;
   *   5. Take Control after the clear reaches MOBILE_DRIVE ON the new
   *      conversation, a mobile ACP turn completes there, handback returns to
   *      LOCAL_DRIVE.
   * The slash commands are typed through the same PTY keystroke path a mobile
   * prompt uses in LOCAL_DRIVE (`start_task` → `AgentService.sendCommand` →
   * the PTY) — they reach the TUI exactly as if the user typed them.
   *
   * Same file (not a sibling) ON PURPOSE: vitest runs files in parallel, and
   * two concurrent native TUIs race on the shared `~/.claude.json`
   * (`ensureClaudeOnboarded` is a read-modify-write), so one of them re-opens
   * the workspace-trust dialog and never takes its turn. Tests within a file
   * run sequentially.
   */
  it('/clear rebinds the mirror + Take Control to the NEW conversation; /rename does not break it', async () => {
    const exits: Array<{ code: number | undefined }> = [];
    backend.reset();
    const { rec, enqueue, lastBaton, lastState } = backend;

    const cwd = makeSessionCwd();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits.push({ code });
      return undefined as never;
    }) as typeof process.exit);

    const { runBatonSession } = await import('../../src/baton/wire-baton');
    const { getAcpAdapter } = await import('../../src/agents/acp/adapters');
    const adapter = getAcpAdapter('claude');
    if (!adapter) throw new Error('claude ACP adapter not resolvable');

    const sessionId = `baton-clear-int-${randomUUID()}`;
    const pluginId = `plugin-${randomUUID()}`;

    /** Did the mirror live-publish `userText` and a completed agent reply after it? */
    const mirroredTurn = (userText: string): boolean => {
      const frames = rec.outputFrames;
      const at = frames.findIndex((f) => f.type === 'user_message' && f.content === userText);
      if (at < 0) return false;
      return frames.slice(at + 1).some((f) => f.type === 'text' && f.done === true);
    };
    /** The reply text the mirror published right after `userText`. */
    const replyAfter = (userText: string): string => {
      const frames = rec.outputFrames;
      const at = frames.findIndex((f) => f.type === 'user_message' && f.content === userText);
      const reply = frames.slice(at + 1).find((f) => f.type === 'text' && f.done === true);
      return typeof reply?.content === 'string' ? reply.content : '';
    };

    try {
      void runBatonSession({
        agent: 'claude',
        sessionId,
        pluginId,
        pluginAuthToken: 'int-token',
        cwd,
        adapter,
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[baton-local] runBatonSession threw (clear scenario):', err);
      });

      // ── 0. Up, driving locally, on the pre-minted conversation id. ──────
      await waitUntil(
        'baton_state LOCAL_DRIVE',
        () => rec.batonEvents.some((e) => e.state === 'LOCAL_DRIVE'),
        90_000,
      );
      const originalId = lastBaton()?.conversationId;
      expect(originalId, 'begin() must publish the pre-minted conversation id').toBeTruthy();
      // Let the TUI finish booting before typing into it.
      await new Promise((r) => setTimeout(r, 12_000));

      // ── 1. A turn in the TUI BEFORE /clear is mirrored live to mobile. ──
      enqueue({
        id: 'cmd-turn-1',
        sessionId,
        type: 'start_task',
        payload: { prompt: 'Reply with the single word ONE.' },
      });
      await waitUntil(
        'the pre-clear TUI turn to be mirrored live (user_message + completed reply)',
        () => mirroredTurn('Reply with the single word ONE.'),
        180_000,
      );
      expect(replyAfter('Reply with the single word ONE.')).toMatch(/ONE/i);
      expect(transcriptIds(cwd), 'the pre-clear turn lives in the pre-minted transcript').toEqual([
        originalId,
      ]);

      // ── 2. /clear in the TUI → claude mints a NEW conversation; the baton
      //       must re-publish LOCAL_DRIVE bound to that new id. ─────────────
      const batonEventsBeforeClear = rec.batonEvents.length;
      enqueue({ id: 'cmd-clear', sessionId, type: 'start_task', payload: { prompt: '/clear' } });
      await waitUntil(
        'baton_state LOCAL_DRIVE re-published with a NEW conversation id after /clear',
        () =>
          rec.batonEvents
            .slice(batonEventsBeforeClear)
            .some((e) => e.state === 'LOCAL_DRIVE' && !!e.conversationId && e.conversationId !== originalId),
        90_000,
      );
      const newId = lastBaton()?.conversationId as string;
      expect(newId).not.toBe(originalId);
      expect(lastState()).toBe('LOCAL_DRIVE');
      // …and the id the baton bound IS the transcript claude actually created.
      expect(transcriptIds(cwd).sort()).toEqual([originalId as string, newId].sort());

      // ── 3. /rename in the TUI → records land in the NEW file, no switch. ──
      const batonEventsBeforeRename = rec.batonEvents.length;
      enqueue({
        id: 'cmd-rename',
        sessionId,
        type: 'start_task',
        payload: { prompt: `/rename ${RENAMED_TITLE}` },
      });
      await waitUntil(
        "claude to write the custom-title record for /rename into the NEW conversation's transcript",
        () => transcriptRaw(cwd, newId).includes(RENAMED_TITLE),
        60_000,
      );
      expect(
        rec.batonEvents.slice(batonEventsBeforeRename).filter((e) => e.conversationId !== newId),
        '/rename must not re-point the baton at another conversation',
      ).toEqual([]);

      // ── 4. A turn AFTER /clear + /rename is mirrored live from the NEW
      //       transcript, snapshotted under the NEW id, no slash echo leaks. ──
      enqueue({
        id: 'cmd-turn-2',
        sessionId,
        type: 'start_task',
        payload: { prompt: 'Reply with the single word TWO.' },
      });
      await waitUntil(
        'the post-clear TUI turn to be mirrored live from the NEW transcript',
        () => mirroredTurn('Reply with the single word TWO.'),
        180_000,
      );
      expect(replyAfter('Reply with the single word TWO.')).toMatch(/TWO/i);
      const newSnapshots = rec.conversations.filter((c) => c.conversationId === newId);
      expect(newSnapshots.length, 'a conversation snapshot keyed by the NEW id').toBeGreaterThan(0);
      const lastNew = newSnapshots[newSnapshots.length - 1];
      expect(lastNew.messages.map((m) => m.role)).toEqual(['user', 'agent']);
      expect(lastNew.messages[0].text).toBe('Reply with the single word TWO.');
      // The `/clear` + `/rename` echoes are TUI bookkeeping, never chat.
      const echoFrames = rec.outputFrames.filter(
        (f) => typeof f.content === 'string' && f.content.includes('<command-name>'),
      );
      expect(echoFrames, 'slash-command echoes leaked into the chat pipe').toEqual([]);
      expect(
        rec.conversations.flatMap((c) => c.messages).filter((m) => m.text.includes('<command-name>')),
        'slash-command echoes leaked into a conversation snapshot',
      ).toEqual([]);

      // ── 5. Take Control after the clear → MOBILE_DRIVE on the NEW
      //       conversation; a mobile turn runs there; handback. ─────────────
      enqueue({ id: 'cmd-take', sessionId, type: 'take_control', payload: {} });
      await waitUntil(
        'baton_state MOBILE_DRIVE after /clear (session/load of the NEW conversation)',
        () => lastState() === 'MOBILE_DRIVE',
        120_000,
      );
      expect(lastBaton()?.conversationId, 'Take Control must resume the NEW conversation').toBe(newId);
      enqueue({
        id: 'cmd-mobile-turn',
        sessionId,
        type: 'start_task',
        payload: { prompt: 'Reply with the single word THREE.' },
      });
      await waitUntil(
        'the mobile ACP turn on the new conversation to complete',
        () => rec.results.some((r) => r.commandId === 'cmd-mobile-turn' && r.status === 'completed'),
        180_000,
      );
      enqueue({ id: 'cmd-back', sessionId, type: 'handback', payload: {} });
      await waitUntil('baton_state LOCAL_DRIVE after handback', () => lastState() === 'LOCAL_DRIVE', 120_000);
      expect(lastBaton()?.conversationId).toBe(newId);

      // No raw TUI chrome anywhere in the chat pipe, across the whole run.
      const chromeFrames = rec.outputFrames.filter((f) => {
        const text = typeof f.content === 'string' ? f.content : '';
        return CHROME_MARKERS.some((m) => text.includes(m));
      });
      expect(chromeFrames.map((f) => String(f.content).slice(0, 120))).toEqual([]);

      process.emit('SIGINT');
      await waitUntil('process exit after SIGINT', () => exits.some((e) => e.code === 0), 30_000);
    } finally {
      exitSpy.mockRestore();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 900_000);
});
