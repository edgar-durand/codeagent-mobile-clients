/**
 * The agent's door into the in-app Preview.
 *
 * The session's agent gets a small MCP server (`codeam preview-mcp`, see
 * `commands/preview-mcp.ts`) whose tools land HERE, inside the running CLI,
 * over a loopback HTTP port guarded by a per-process random token. From here
 * they run the SAME pipeline the Preview button runs — `resolvePreviewDetection`
 * then `startPreviewFromDetection` — so an agent-started preview is not a second
 * implementation that can drift: it is the button, without the confirm sheet.
 *
 * Every event it emits carries `origin: 'agent'`. That one field is what makes
 * the app skip the confirm sheet, paint the "Initializing Preview…" card in the
 * chat and switch to the preview plane when it is ready.
 *
 * ⚠️ Why a port and not the backend: the agent's tool call has to BLOCK until
 * the preview serves (or fails) so it gets the URL back and can keep working —
 * curl it, point at an element, or fix the error. The backend is events-only
 * by design (preview spec) and cannot answer a caller. The pipeline lives in
 * this process anyway.
 *
 * ⚠️ Loopback only, token required: any local process could otherwise start
 * dev servers or draw on the user's preview. The token never leaves this
 * machine — it rides the MCP server's env (never argv, which `ps` shows).
 */
import * as http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { USER_EVENTS, type PreviewDetection } from '@codeam/shared';
import type { RuntimeStrategy } from '../../agents/strategy';
import { postPreviewEvent } from '../../services/pairing.service';
import { activePreviews, killPreview, resetBuildHealState } from '../../services/preview';
import { log } from '../../services/logger';
import {
  resolvePreviewDetection,
  startPreviewFromDetection,
  type PreviewCtx,
} from './handlers';

/** What the bridge needs from the session — set once the agent runner is up. */
export interface AgentPreviewContext extends PreviewCtx {
  /** Lazy: built only when the agent actually asks for detection. */
  getRuntime: () => RuntimeStrategy;
  pluginAuthToken?: string;
}

export type AgentPreviewResult =
  | { status: 'running'; url: string; framework: string; reused?: boolean; inspector: boolean }
  | { status: 'starting'; message: string }
  | { status: 'error'; stage: string; message: string }
  | { status: 'idle' };

/** Optional detection the agent may pass when it already knows how to start the app. */
export interface AgentDetectionOverride {
  command: string;
  args?: string[];
  port: number;
  framework?: string;
  ready_pattern?: string;
}

/**
 * How long `start_preview` blocks before answering "still starting". A cold
 * monorepo (install + an Nx ready timeout of 6 min) can outlast any sane MCP
 * call, so the tool returns and the bring-up keeps going; `preview_status`
 * picks it up.
 */
export const START_WAIT_MS = 240_000;

const MAX_SELECTOR = 500;
const MAX_LABEL = 80;

export class AgentPreviewBridge {
  private server: http.Server | null = null;
  private listening: Promise<{ url: string; token: string } | null> | null = null;
  private readonly token = randomBytes(24).toString('hex');
  private ctx: AgentPreviewContext | null = null;
  /** The bring-up in flight, so two tool calls never start two dev servers. */
  private inflight: Promise<AgentPreviewResult> | null = null;
  private lastError: { stage: string; message: string } | null = null;
  private bound: { url: string; token: string } | null = null;

  /** Start the loopback server once. `null` when it could not bind — the
   *  preview tools are then simply absent, never a failed session. */
  listen(): Promise<{ url: string; token: string } | null> {
    if (this.listening) return this.listening;
    this.listening = new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      server.on('error', (err) => {
        log.warn('agent-preview', `bridge failed to listen: ${String(err)}`);
        resolve(null);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          resolve(null);
          return;
        }
        // Never keep the CLI alive just for this door.
        server.unref();
        this.server = server;
        this.bound = { url: `http://127.0.0.1:${addr.port}`, token: this.token };
        resolve(this.bound);
      });
    });
    return this.listening;
  }

  /** The bound address once {@link listen} resolved, else null (sync, for
   *  the MCP list rebuilds that happen mid-session). */
  address(): { url: string; token: string } | null {
    return this.bound;
  }

  /** Bind the live session. Tool calls before this answer "still starting". */
  attach(ctx: AgentPreviewContext): void {
    this.ctx = ctx;
  }

  close(): void {
    this.server?.close();
    this.server = null;
  }

  // ─── Operations (public for tests) ─────────────────────────────────────

  async start(
    override?: AgentDetectionOverride,
    waitMs: number = START_WAIT_MS,
  ): Promise<AgentPreviewResult> {
    const ctx = this.ctx;
    if (!ctx?.pluginAuthToken) {
      return {
        status: 'error',
        stage: 'session',
        message: 'The session is still starting (or has no pairing token) — try again in a few seconds.',
      };
    }
    if (!this.inflight) {
      const run = this.launch(ctx, ctx.pluginAuthToken, override);
      this.inflight = run;
      void run.finally(() => {
        if (this.inflight === run) this.inflight = null;
      });
    }
    const inflight = this.inflight;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<AgentPreviewResult>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            status: 'starting',
            message:
              'The preview is still coming up (dependencies or a slow dev server). It keeps going in the background — call preview_status in a minute.',
          }),
        waitMs,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([inflight, pending]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  status(): AgentPreviewResult {
    const ctx = this.ctx;
    if (!ctx) return { status: 'idle' };
    const active = serving(ctx.sessionId);
    if (active) return running(active, true);
    if (this.inflight) return { status: 'starting', message: 'The preview is starting.' };
    if (this.lastError) return { status: 'error', ...this.lastError };
    return { status: 'idle' };
  }

  async highlight(input: { selector?: unknown; label?: unknown; clear?: unknown }): Promise<{
    ok: boolean;
    message: string;
  }> {
    const ctx = this.ctx;
    if (!ctx?.pluginAuthToken) return { ok: false, message: 'The session is still starting.' };
    const active = serving(ctx.sessionId);
    if (!active) {
      return { ok: false, message: 'No preview is running — call start_preview first.' };
    }
    if (!active.inspector) {
      return {
        ok: false,
        message: `Element highlighting needs the web inspector, which ${active.framework} previews don't have.`,
      };
    }
    let payload: Record<string, unknown>;
    if (input.clear === true) {
      payload = { clear: true };
    } else {
      const selector = typeof input.selector === 'string' ? input.selector.trim() : '';
      if (!selector || selector.length > MAX_SELECTOR) {
        return { ok: false, message: `selector must be a CSS selector of 1-${MAX_SELECTOR} characters.` };
      }
      const label = typeof input.label === 'string' ? input.label.trim().slice(0, MAX_LABEL) : '';
      payload = label ? { selector, label } : { selector };
    }
    const res = await postPreviewEvent({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken: ctx.pluginAuthToken,
      type: USER_EVENTS.PREVIEW_AGENT_HIGHLIGHT,
      payload,
    });
    if (!res.ok) {
      return { ok: false, message: `Could not reach the app (${res.status}): ${res.message}` };
    }
    return {
      ok: true,
      message:
        payload.clear === true
          ? 'Cleared your marks from the preview.'
          : `Marked ${String(payload.selector)} in the user's preview. If the selector matches nothing, no mark appears.`,
    };
  }

  async stop(): Promise<{ ok: boolean; message: string }> {
    const ctx = this.ctx;
    if (!ctx?.pluginAuthToken) return { ok: false, message: 'The session is still starting.' };
    if (!activePreviews.has(ctx.sessionId)) return { ok: true, message: 'No preview was running.' };
    await killPreview(ctx.sessionId);
    resetBuildHealState(ctx.sessionId);
    await postPreviewEvent({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken: ctx.pluginAuthToken,
      type: USER_EVENTS.PREVIEW_STOPPED,
      payload: { reason: 'user', origin: 'agent' },
    });
    return { ok: true, message: 'Preview stopped.' };
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private async launch(
    ctx: AgentPreviewContext,
    pluginAuthToken: string,
    override?: AgentDetectionOverride,
  ): Promise<AgentPreviewResult> {
    this.lastError = null;
    const already = serving(ctx.sessionId);
    if (already) {
      // Still announce it: the app switches to the preview plane and the
      // chat card resolves, exactly as for a fresh start.
      await postPreviewEvent({
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        pluginAuthToken,
        type: USER_EVENTS.PREVIEW_READY,
        payload: {
          url: already.url,
          framework: already.framework,
          port: already.detection.port,
          origin: 'agent',
        },
      });
      return running(already, true);
    }

    // First frame right away: the card appears in the chat while detection
    // (often a cache hit) resolves.
    void postPreviewEvent({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken,
      type: USER_EVENTS.PREVIEW_DETECTION_PENDING,
      payload: { origin: 'agent' },
    });

    const detection =
      (override && detectionFromOverride(override)) ??
      (await resolvePreviewDetection({ ctx, runtime: ctx.getRuntime(), pluginAuthToken, origin: 'agent' }));
    if (!detection) {
      // resolvePreviewDetection already reported the error to the app.
      const err = { stage: 'detection', message: 'Could not work out how to start this project.' };
      this.lastError = err;
      return { status: 'error', ...err };
    }

    let failure: { stage: string; message: string } | null = null;
    await startPreviewFromDetection(ctx, detection, pluginAuthToken, {
      origin: 'agent',
      onEvent: (type, payload) => {
        if (type === USER_EVENTS.PREVIEW_ERROR) {
          failure = {
            stage: String(payload.stage ?? 'spawn'),
            message: String(payload.message ?? 'The preview failed to start.'),
          };
        }
      },
    });
    const up = serving(ctx.sessionId);
    if (up) return running(up, false);
    const err = failure ?? { stage: 'spawn', message: 'The preview did not come up.' };
    this.lastError = err;
    return { status: 'error', ...err };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!authorized(req.headers.authorization, this.token)) return reply(401, { error: 'unauthorized' });
    try {
      const body = req.method === 'POST' ? await readJson(req) : {};
      switch (`${req.method} ${req.url}`) {
        case 'POST /preview/start':
          return reply(200, await this.start(overrideFrom(body)));
        case 'GET /preview/status':
          return reply(200, this.status());
        case 'POST /preview/highlight':
          return reply(200, await this.highlight(body));
        case 'POST /preview/stop':
          return reply(200, await this.stop());
        default:
          return reply(404, { error: 'not found' });
      }
    } catch (err) {
      log.warn('agent-preview', `bridge request failed: ${String(err)}`);
      return reply(500, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

function serving(sessionId: string) {
  const active = activePreviews.get(sessionId);
  // Adopted previews (`devServer === null`) serve by definition.
  if (!active || (active.devServer && active.devServer.exitCode !== null)) return null;
  return active;
}

function running(
  active: NonNullable<ReturnType<typeof serving>>,
  reused: boolean,
): AgentPreviewResult {
  return {
    status: 'running',
    url: active.url,
    framework: active.framework,
    ...(reused ? { reused: true } : {}),
    inspector: Boolean(active.inspector),
  };
}

function detectionFromOverride(o: AgentDetectionOverride): PreviewDetection | null {
  if (!o.command || !Number.isInteger(o.port) || o.port <= 0 || o.port > 65_535) return null;
  return {
    framework: o.framework?.trim() || 'custom',
    command: o.command,
    args: Array.isArray(o.args) ? o.args.map(String) : [],
    port: o.port,
    // Any Local/ready/listening line; the TCP probe is the real fallback.
    ready_pattern: o.ready_pattern?.trim() || '(ready|local:|listening|started server|compiled)',
  };
}

function overrideFrom(body: Record<string, unknown>): AgentDetectionOverride | undefined {
  if (typeof body.command !== 'string' || typeof body.port !== 'number') return undefined;
  return {
    command: body.command,
    args: Array.isArray(body.args) ? body.args.map(String) : undefined,
    port: body.port,
    framework: typeof body.framework === 'string' ? body.framework : undefined,
    ready_pattern: typeof body.ready_pattern === 'string' ? body.ready_pattern : undefined,
  };
}

function authorized(header: string | undefined, token: string): boolean {
  const presented = Buffer.from((header ?? '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.length > 64_000) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        const parsed: unknown = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** One bridge per CLI process — the MCP entry and the runner share it. */
export const agentPreviewBridge = new AgentPreviewBridge();
