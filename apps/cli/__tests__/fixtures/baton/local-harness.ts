/**
 * Shared harness for the REAL local-session baton integration tests
 * (`__tests__/integration/baton-local*.int.test.ts`): the `RUN_BATON_INT`
 * gate + claude preflight, the in-process STUB BACKEND that serves the
 * pairing/relay endpoints and records everything the CLI posts, and the
 * small wait/transcript helpers. Lives under `fixtures/` (excluded from the
 * vitest glob) because it declares no suite of its own.
 *
 * ── Gating ───────────────────────────────────────────────────────────────
 * The suites only run with `RUN_BATON_INT=1`:
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
 * per-developer credential is involved. See `.github/workflows/ci.yml` and
 * the README in `__tests__/integration/`.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureClaudeOnboarded } from '../../../src/agents/claude/onboarding';
import { resolveHistoryDir } from '../../../src/agents/claude/history';

export const RUN_BATON_INT = process.env.RUN_BATON_INT === '1';
/** GitHub Actions (and every other runner we use) sets `CI=true`. */
export const IN_CI = process.env.CI === 'true';

/** House-agent / BYO credential delivered through the environment. */
const HAS_ENV_CREDENTIAL = Boolean(
  process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN,
);

export function describeErr(err: unknown): string {
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

export const BINARY = RUN_BATON_INT ? probeClaudeBinary() : ({ ok: false, reason: 'gate off' } as const);

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

export const BLOCKED = RUN_BATON_INT ? blockedReason() : null;

/** Print the gate decision once per suite file. */
export function announceGate(suite: string): void {
  if (!RUN_BATON_INT) {
    // eslint-disable-next-line no-console
    console.log(
      `[${suite}] SKIPPED — set RUN_BATON_INT=1 (with a claude backend) to run the real local-baton gate.`,
    );
  } else if (BLOCKED && !IN_CI) {
    // eslint-disable-next-line no-console
    console.log(`[${suite}] SKIPPED — ${BLOCKED}`);
  } else if (BINARY.ok) {
    // eslint-disable-next-line no-console
    console.log(`[${suite}] RUNNING against claude ${BINARY.version}`);
  }
}

/**
 * `beforeAll` body for the real suites: pre-complete Claude's first-run
 * onboarding (theme picker + changelog banner) exactly as the product does on
 * every non-local surface (`start.ts` → `ensureClaudeOnboarded`) — a CI
 * runner's HOME is fresh, so without this the native TUI opens on the theme
 * dialog and never takes a turn — and, in CI only, a live auth probe so an
 * unauthenticated backend surfaces immediately, quoting what claude said,
 * instead of 3 minutes later as an opaque "timed out waiting for the turn".
 */
export function preflight(suite: string): void {
  ensureClaudeOnboarded();
  if (!IN_CI) return;
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
    console.log(`[${suite}] auth preflight ok: ${JSON.stringify(out.trim().slice(0, 120))}`);
  } catch (err) {
    throw new Error(
      `[${suite}] CI GATE CANNOT RUN — the house-agent backend did not answer a one-shot turn.\n` +
        `ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL ?? '(unset)'} ` +
        `ANTHROPIC_AUTH_TOKEN=${process.env.ANTHROPIC_AUTH_TOKEN ? '(set)' : '(EMPTY/unset)'}\n` +
        describeErr(err),
    );
  } finally {
    fs.rmSync(probeCwd, { recursive: true, force: true });
  }
}

/** TUI chrome that must NEVER reach the chat pipe (the owner's screenshot). */
export const CHROME_MARKERS = ['─', '│', '╭', '╰', '❯', 'shift+tab to cycle', 'esc to interrupt', '�'];

export interface BatonStateEvent {
  state: string;
  driver: string;
  conversationId: string | null;
}

export interface Recorded {
  /** Every `/api/baton/events` post, in arrival order. */
  batonEvents: BatonStateEvent[];
  heartbeats: Array<{ online: boolean }>;
  outputFrames: Array<Record<string, unknown>>;
  results: Array<{ commandId: string; status: string }>;
  /** Every `/api/sessions/conversation` snapshot (`sessionId` = conversation id). */
  conversations: Array<{ conversationId: string; messages: Array<{ role: string; text: string }> }>;
}

export interface StubBackend {
  rec: Recorded;
  /** Queue a relay command for the CLI's next `/api/commands/pending` poll. */
  enqueue: (cmd: Record<string, unknown>) => void;
  /** `http://127.0.0.1:<port>` */
  url: string;
  close: () => Promise<void>;
  /** The last `baton_state` posted, or undefined. */
  lastBaton: () => BatonStateEvent | undefined;
  lastState: () => string | undefined;
  sawOffline: () => boolean;
  /** Forget everything recorded + queued so the next scenario starts clean. */
  reset: () => void;
}

/**
 * In-process stub of the backend surface the baton session talks to. Only the
 * backend is faked — nothing in `src/` is mocked. Sets `CODEAM_API_URL` (it
 * MUST be set before importing anything that captures the API base at module
 * load: pairing.service, chunk-emitter, command-relay); `close()` unsets it.
 *
 * ⚠️ ONE per test FILE (start it in `beforeAll`, `reset()` between scenarios):
 * the CLI modules capture the API base once at import, and vitest caches
 * modules per file — a second stub on a new port would never receive a post.
 */
export async function startStubBackend(): Promise<StubBackend> {
  const rec: Recorded = { batonEvents: [], heartbeats: [], outputFrames: [], results: [], conversations: [] };
  const pending: Array<Record<string, unknown>> = [];
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
        rec.batonEvents.push({
          state: String(body.state),
          driver: String(body.driver),
          conversationId: typeof body.conversationId === 'string' ? body.conversationId : null,
        });
        return reply({ success: true });
      }
      if (url.startsWith('/api/commands/output')) {
        rec.outputFrames.push(body);
        return reply({ success: true });
      }
      if (url.startsWith('/api/commands/result')) {
        rec.results.push({ commandId: String(body.commandId), status: String(body.status) });
        return reply({ success: true });
      }
      if (url.startsWith('/api/sessions/conversation')) {
        const messages = Array.isArray(body.messages)
          ? (body.messages as Array<{ role: string; text: string }>).map((m) => ({ role: m.role, text: m.text }))
          : [];
        rec.conversations.push({ conversationId: String(body.sessionId), messages });
        return reply({ success: true });
      }
      return reply({ success: true, data: {} });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  process.env.CODEAM_API_URL = url;
  return {
    rec,
    url,
    enqueue: (cmd) => {
      pending.push(cmd);
    },
    lastBaton: () => rec.batonEvents[rec.batonEvents.length - 1],
    lastState: () => rec.batonEvents[rec.batonEvents.length - 1]?.state,
    sawOffline: () => rec.heartbeats.some((h) => h.online === false),
    reset: () => {
      rec.batonEvents.length = 0;
      rec.heartbeats.length = 0;
      rec.outputFrames.length = 0;
      rec.results.length = 0;
      rec.conversations.length = 0;
      pending.length = 0;
    },
    close: async () => {
      delete process.env.CODEAM_API_URL;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Poll `predicate` until true (real timers), or fail with `label`. */
export async function waitUntil(label: string, predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for: ${label}`);
}

/** Every `<conversation>.jsonl` claude has written for `cwd`, if any (ids, no extension). */
export function transcriptIds(cwd: string): string[] {
  const dir = resolveHistoryDir(cwd);
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length));
  } catch {
    return [];
  }
}

/** Raw contents of `<cwd>`'s `<id>.jsonl`, or '' when absent. */
export function transcriptRaw(cwd: string, id: string): string {
  const dir = resolveHistoryDir(cwd);
  if (!dir) return '';
  try {
    return fs.readFileSync(path.join(dir, `${id}.jsonl`), 'utf8');
  } catch {
    return '';
  }
}

/** A fresh, pre-trusted temp cwd for the native TUI. */
export function makeSessionCwd(): string {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-baton-local-')));
  // Pre-accept the per-workspace "do you trust this folder?" dialog for THIS
  // cwd — a fresh temp dir is always untrusted and the TUI would wedge on it.
  ensureClaudeOnboarded(cwd);
  return cwd;
}
