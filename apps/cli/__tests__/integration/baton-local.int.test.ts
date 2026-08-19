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
 * ── Gating ───────────────────────────────────────────────────────────────
 * The suite only runs with `RUN_BATON_INT=1`:
 *
 *   RUN_BATON_INT=1 npx vitest run integration/baton-local
 *
 * With the gate set, the behaviour on a missing/unauthenticated `claude`
 * DIFFERS by environment ON PURPOSE:
 *
 *   - **local** (`CI` unset) → skips with a printed reason, so a contributor
 *     without a claude backend isn't blocked.
 *   - **CI** (`CI=true`) → **FAILS LOUDLY** with the exact reason. This step is
 *     a real gate; a silently-skipped gate is worse than no gate, because it
 *     reads green while proving nothing.
 *
 * In CI the agent authenticates exactly like a **house agent ("CodeAgent
 * Cloud") session**: Claude Code pointed at our managed backend via
 * `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (+ the MiniMax model pins) —
 * the same env `host-agent.ts` writes for a house `self_hosted_deploy`. No
 * per-developer credential is involved. See
 * `.github/workflows/ci.yml` and the README in this directory.
 *
 * ⚠️ `process.exit` is stubbed for the duration (the CLI's shutdown paths call
 * it), which is also what lets the goodbye assertion observe the ORDER: the
 * exit spy records whether the offline heartbeat had already landed when it
 * fired.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ensureClaudeOnboarded } from '../../src/agents/claude/onboarding';
import { resolveHistoryDir } from '../../src/agents/claude/history';

const RUN_BATON_INT = process.env.RUN_BATON_INT === '1';
/** GitHub Actions (and every other runner we use) sets `CI=true`. */
const IN_CI = process.env.CI === 'true';

/** House-agent / BYO credential delivered through the environment. */
const HAS_ENV_CREDENTIAL = Boolean(
  process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN,
);

function describeErr(err: unknown): string {
  const e = err as { message?: string; stdout?: unknown; stderr?: unknown };
  return [e?.message, String(e?.stdout ?? ''), String(e?.stderr ?? '')]
    .filter((s) => s && s.trim())
    .join('\n')
    .slice(0, 2000);
}

/** `claude --version`, or the reason it isn't usable. */
function probeClaudeBinary(): { ok: true; version: string } | { ok: false; reason: string } {
  try {
    const out = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 60_000 });
    return { ok: true, version: out.trim() };
  } catch (err) {
    return {
      ok: false,
      reason: `\`claude --version\` failed — no usable claude binary on PATH: ${describeErr(err)}`,
    };
  }
}

const BINARY = RUN_BATON_INT ? probeClaudeBinary() : ({ ok: false, reason: 'gate off' } as const);

/**
 * Why this run cannot exercise the real gate — `null` when it can.
 * In CI every one of these becomes a FAILING test; locally, a skip.
 */
function blockedReason(): string | null {
  if (!BINARY.ok) return BINARY.reason;
  if (IN_CI && !HAS_ENV_CREDENTIAL) {
    return (
      'no agent credential in the environment. This gate runs Claude Code as a HOUSE AGENT ' +
      '("CodeAgent Cloud"): set ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (the ci.yml step ' +
      'feeds ANTHROPIC_AUTH_TOKEN from the MINIMAX_API_KEY repo secret). An empty secret ' +
      'renders as an empty env var, which is exactly this failure.'
    );
  }
  return null;
}

const BLOCKED = RUN_BATON_INT ? blockedReason() : null;

if (!RUN_BATON_INT) {
  // eslint-disable-next-line no-console
  console.log(
    '[baton-local] SKIPPED — set RUN_BATON_INT=1 (with a claude backend) to run the real local-baton gate.',
  );
} else if (BLOCKED && !IN_CI) {
  // eslint-disable-next-line no-console
  console.log(`[baton-local] SKIPPED — ${BLOCKED}`);
} else if (BINARY.ok) {
  // eslint-disable-next-line no-console
  console.log(`[baton-local] RUNNING against claude ${BINARY.version}`);
}

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

/** Every `<conversation>.jsonl` claude has written for `cwd`, if any. */
function transcriptFiles(cwd: string): string[] {
  const dir = resolveHistoryDir(cwd);
  if (!dir) return [];
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
}

describe.skipIf(!RUN_BATON_INT || BLOCKED !== null)('session baton — real local session (claude)', () => {
  beforeAll(() => {
    // Pre-complete Claude's first-run theme picker + changelog banner exactly as
    // the product does on every non-local surface (`start.ts` →
    // `ensureClaudeOnboarded`). A CI runner's HOME is fresh, so without this the
    // native TUI opens on the theme dialog and never takes a turn. Idempotent
    // and merge-preserving, so it is a no-op on a developer's own machine.
    ensureClaudeOnboarded();

    if (!IN_CI) return;
    // CI-only live auth probe. Without it an unauthenticated backend surfaces
    // 3 minutes later as an opaque "timed out waiting for the ACP turn"; here it
    // surfaces immediately, quoting what claude actually said.
    const probeCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-baton-preflight-')));
    ensureClaudeOnboarded(probeCwd);
    try {
      const out = execFileSync(
        'claude',
        ['--print', '--dangerously-skip-permissions', 'Reply with the single word READY.'],
        { cwd: probeCwd, encoding: 'utf8', timeout: 240_000, env: { ...process.env } },
      );
      if (!out.trim()) {
        throw new Error('claude --print returned EMPTY output — the backend answered nothing.');
      }
      // eslint-disable-next-line no-console
      console.log(`[baton-local] auth preflight ok: ${JSON.stringify(out.trim().slice(0, 120))}`);
    } catch (err) {
      throw new Error(
        '[baton-local] CI GATE CANNOT RUN — the house-agent backend did not answer a one-shot turn.\n' +
          `ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL ?? '(unset)'} ` +
          `ANTHROPIC_AUTH_TOKEN=${process.env.ANTHROPIC_AUTH_TOKEN ? '(set)' : '(EMPTY/unset)'}\n` +
          describeErr(err),
      );
    } finally {
      fs.rmSync(probeCwd, { recursive: true, force: true });
    }
  }, 300_000);

  it('take-control BEFORE the first turn AND after one on disk → MOBILE_DRIVE both times, handback → LOCAL_DRIVE, no TUI bytes in chat, goodbye on SIGINT', async () => {
    const rec: Recorded = { batonStates: [], heartbeats: [], outputFrames: [], results: [] };
    const pending: Array<Record<string, unknown>> = [];
    const exits: Array<{ code: number | undefined; sawOffline: boolean }> = [];
    const sawOffline = (): boolean => rec.heartbeats.some((h) => h.online === false);
    const lastState = (): string | undefined => rec.batonStates[rec.batonStates.length - 1];

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
    // Pre-accept the per-workspace "do you trust this folder?" dialog for THIS
    // cwd — a fresh temp dir is always untrusted and the TUI would wedge on it.
    ensureClaudeOnboarded(cwd);
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

      // 2. ── BRANCH A: Take Control with ZERO turns on this conversation ──
      //    The exact owner scenario. The native driver pre-minted the id at
      //    spawn and claude has not written `<id>.jsonl` yet, so `session/load`
      //    has nothing to load — `AcpDriver` must mint a FRESH ACP session
      //    instead of hanging. Let the TUI finish booting first (it must be
      //    genuinely up, just turn-less), then hand over.
      await new Promise((r) => setTimeout(r, 12_000));
      expect(
        transcriptFiles(cwd),
        'BRANCH A precondition: claude must not have written a transcript yet',
      ).toEqual([]);
      pending.push({ id: 'cmd-take-1', sessionId, type: 'take_control', payload: {} });
      await waitUntil(
        'baton_state MOBILE_DRIVE (branch A: zero turns — not stuck in SWITCHING)',
        () => lastState() === 'MOBILE_DRIVE',
        120_000,
      );

      // 3. A real turn from "mobile" over ACP, so the conversation actually
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

      // 4. Handback returns the baton to the terminal.
      pending.push({ id: 'cmd-back-1', sessionId, type: 'handback', payload: {} });
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
      pending.push({
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
        () => transcriptFiles(cwd).length > 0,
        180_000,
      );
      pending.push({ id: 'cmd-take-2', sessionId, type: 'take_control', payload: {} });
      await waitUntil(
        'baton_state MOBILE_DRIVE (branch B: session/load over an existing transcript)',
        () => lastState() === 'MOBILE_DRIVE',
        120_000,
      );

      // 7. …and back to the terminal one more time.
      pending.push({ id: 'cmd-back-2', sessionId, type: 'handback', payload: {} });
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
      delete process.env.CODEAM_API_URL;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 900_000);
});
