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
 * It reproduces, end to end, the three bugs the owner hit on 2026-08-18:
 *
 *   1. **Take Control before the first TUI turn.** The native driver pre-mints
 *      the conversation id at spawn, but claude writes `<id>.jsonl` only on its
 *      first turn — so `session/load` for that id never resolved and the baton
 *      sat in `SWITCHING` forever. Asserted: `MOBILE_DRIVE` lands (and the state
 *      is not stuck on `SWITCHING`).
 *   2. **Handback.** After a real ACP turn from "mobile", the baton returns to
 *      `LOCAL_DRIVE` on the same conversation.
 *   3. **No screen-scrape in LOCAL_DRIVE.** Not one `/api/commands/output`
 *      frame carries raw TUI chrome (box drawing, `❯`, "shift+tab to cycle").
 *   4. **Goodbye heartbeat.** SIGINT posts `online:false` BEFORE the process
 *      exits, so mobile stops showing the session as online.
 *
 * ── Gating ───────────────────────────────────────────────────────────────
 * Skipped unless `RUN_BATON_INT=1` AND an authenticated `claude` is on PATH
 * (CI has neither):
 *
 *   RUN_BATON_INT=1 npx vitest run integration/baton-local
 *
 * ⚠️ `process.exit` is stubbed for the duration (the CLI's shutdown paths call
 * it), which is also what lets assertion 4 observe the ORDER: the exit spy
 * records whether the offline heartbeat had already landed when it fired.
 */

import { describe, it, expect, vi } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const RUN_BATON_INT = process.env.RUN_BATON_INT === '1';

function claudeIsInstalled(): boolean {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

const HAVE_CLAUDE = RUN_BATON_INT && claudeIsInstalled();

if (!RUN_BATON_INT) {
  // eslint-disable-next-line no-console
  console.log(
    '[baton-local] SKIPPED — set RUN_BATON_INT=1 (with an authenticated `claude` on PATH) to run the real local-baton gate.',
  );
} else if (!HAVE_CLAUDE) {
  // eslint-disable-next-line no-console
  console.log('[baton-local] SKIPPED — `claude --version` failed: no claude binary on PATH.');
}

/** TUI chrome that must NEVER reach the chat pipe (the owner's screenshot). */
const CHROME_MARKERS = ['─', '│', '╭', '╰', '❯', 'shift+tab to cycle', 'esc to interrupt', '�'];

interface Recorded {
  batonStates: string[];
  heartbeats: Array<{ online: boolean }>;
  outputFrames: Array<Record<string, unknown>>;
  results: Array<{ commandId: string; status: string }>;
}

/** Poll `predicate` until true (real timers), or fail with `label`. */
async function waitUntil(
  label: string,
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for: ${label}`);
}

describe.skipIf(!HAVE_CLAUDE)('session baton — real local session (claude)', () => {
  it('take-control BEFORE the first turn → MOBILE_DRIVE → handback → LOCAL_DRIVE, no TUI bytes in chat, goodbye on SIGINT', async () => {
    const rec: Recorded = { batonStates: [], heartbeats: [], outputFrames: [], results: [] };
    const pending: Array<Record<string, unknown>> = [];
    const exits: Array<{ code: number | undefined; sawOffline: boolean }> = [];
    const sawOffline = (): boolean => rec.heartbeats.some((h) => h.online === false);

    // ── Stub backend ────────────────────────────────────────────────────
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const url = req.url ?? '';
        let body: Record<string, unknown> = {};
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          /* non-JSON — ignore */
        }
        const reply = (payload: unknown): void => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (url.startsWith('/api/commands/pending')) {
          const batch = pending.splice(0, pending.length);
          return reply({ data: batch });
        }
        if (url.startsWith('/api/plugin/heartbeat')) {
          rec.heartbeats.push({ online: body.online === true });
          return reply({ success: true });
        }
        if (url.startsWith('/api/baton/events')) {
          rec.batonStates.push(String(body.state));
          return reply({ success: true });
        }
        if (url.startsWith('/api/commands/output')) {
          rec.outputFrames.push(body);
          return reply({ success: true });
        }
        if (url.startsWith('/api/commands/result')) {
          rec.results.push({
            commandId: String(body.commandId),
            status: String(body.status),
          });
          return reply({ success: true });
        }
        return reply({ success: true, data: {} });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    // MUST be set before importing anything that captures the API base at
    // module load (pairing.service, chunk-emitter, command-relay).
    process.env.CODEAM_API_URL = `http://127.0.0.1:${port}`;

    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-baton-local-')));
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
        () => rec.batonStates.includes('LOCAL_DRIVE'),
        90_000,
      );

      // 2. A prompt sent from mobile WHILE the terminal holds the baton. This
      //    is what used to open a legacy PTY turn and pump the native TUI's
      //    raw frames into the chat pipe (assertion 5 below) — the mobile view
      //    in LOCAL_DRIVE must come from the transcript mirror alone.
      pending.push({
        id: 'cmd-local-task',
        sessionId,
        type: 'start_task',
        payload: { prompt: 'Reply with the single word PING.' },
      });
      // Well past OutputService's 1.5 s warm-up + several 1 s render ticks, so
      // any screen-scraped frame would already have been posted.
      await new Promise((r) => setTimeout(r, 20_000));

      // 3. Take Control with ZERO turns typed in the TUI — the exact owner
      //    scenario. The conversation file does not exist on disk yet.
      pending.push({ id: 'cmd-take', sessionId, type: 'take_control', payload: {} });
      await waitUntil(
        'baton_state MOBILE_DRIVE (not stuck in SWITCHING)',
        () => rec.batonStates[rec.batonStates.length - 1] === 'MOBILE_DRIVE',
        120_000,
      );

      // 4. A real turn from "mobile" over ACP, so the conversation actually
      //    exists on disk for the handback to resume.
      pending.push({
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

      // 5. Handback returns the baton to the terminal.
      pending.push({ id: 'cmd-back', sessionId, type: 'handback', payload: {} });
      await waitUntil(
        'baton_state LOCAL_DRIVE again',
        () => rec.batonStates[rec.batonStates.length - 1] === 'LOCAL_DRIVE',
        120_000,
      );

      // 6. Not one chat frame carries raw TUI chrome — LOCAL_DRIVE mirrors
      //    the transcript, it never screen-scrapes.
      const chromeFrames = rec.outputFrames.filter((f) => {
        const text = typeof f.content === 'string' ? f.content : '';
        return CHROME_MARKERS.some((m) => text.includes(m));
      });
      expect(
        chromeFrames.map((f) => String(f.content).slice(0, 120)),
        'raw TUI chrome leaked into the chat pipe',
      ).toEqual([]);

      // 7. Ctrl+C says goodbye BEFORE exiting.
      process.emit('SIGINT');
      await waitUntil(
        'an exit that happened AFTER the online:false heartbeat',
        () => exits.some((e) => e.code === 0 && e.sawOffline),
        30_000,
      );
      expect(sawOffline()).toBe(true);
    } finally {
      exitSpy.mockRestore();
      delete process.env.CODEAM_API_URL;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 600_000);
});
