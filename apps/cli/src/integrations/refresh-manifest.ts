// src/integrations/refresh-manifest.ts
//
// At session start, ask the backend for the session's CURRENT integrations
// manifest and rewrite `~/.codeam/integrations.json` when it differs.
//
// ⚠️ WHY. The box's manifest was written once — at deploy, or by the last
// `integrations_sync` the user triggered by linking/unlinking something — and
// then trusted forever. `resolveDelivery` (mcp-run.ts) prefers that file over
// the CLI's own bundled registry BY DESIGN (the backend's pinned registry is the
// source of truth for what a box runs). Those two facts together meant a
// registry fix never reached an existing box: on 2026-09-03 ClickUp was moved
// off a server that had gone paid (clients #694, api-v2 pin #2710), and after
// the CLI AND the backend were both live with the change, the user's box still
// launched the old package with the old envMapping — its manifest was 4 hours
// old and nothing had asked for a new one. Every existing user was in the same
// position, one paywall away from "not connected", until they happened to
// touch their integrations.
//
// So the start path asks. Best-effort, and it MUST stay that way: a backend
// hiccup at boot falls back to the file on disk exactly as before — a session
// with a stale manifest beats no session.
import { resolveApiBaseUrl, type IntegrationsManifest } from '@codeam/shared';
import {
  hasSessionIntegrationsManifest,
  persistIntegrationsManifest,
  readIntegrationsManifest,
} from './manifest';
import { log } from '../services/logger';

export interface RefreshManifestCtx {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  /**
   * Public id of the agent about to launch — `house-codeagent-cloud` for the
   * house agent, the runtime's own id otherwise. The backend does not know
   * which agent a paired session runs (that is CLI state), and it applies
   * per-agent policy to the manifest: today, `toolRouter` for the house agent
   * only. Omit and the backend applies no agent policy.
   */
  agent?: string;
}

export type RefreshManifestResult =
  | { status: 'unchanged' }
  | { status: 'rewritten'; before: number; after: number }
  | { status: 'skipped'; reason: string };

/**
 * Stable serialization so an equal manifest with different key order is equal.
 * `toolRouter` is part of it: leaving it out kept a running box on its old
 * routing until its integrations changed, so a router rollout or revert never
 * reached existing sessions.
 */
function fingerprint(m: IntegrationsManifest): string {
  const norm = [...m.integrations]
    .map((e) => ({ id: e.id, delivery: e.delivery }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ integrations: norm, toolRouter: m.toolRouter === true });
}

/**
 * Fetch the backend's current manifest for this session and persist it as the
 * session's OWN file (see manifest.ts) if it differs from what the session
 * reads today. Never throws.
 */
export async function refreshIntegrationsManifest(
  ctx: RefreshManifestCtx,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<RefreshManifestResult> {
  const result = await fetchAndPersist(ctx, fetchImpl, timeoutMs);
  // The backend could not answer: the session still takes its own copy of the
  // deploy hand-off, so a later deploy on the same box (which rewrites or
  // deletes the shared file) cannot change this session's integrations.
  if (result.status === 'skipped' && !hasSessionIntegrationsManifest(ctx.sessionId)) {
    const handOff = readIntegrationsManifest();
    if (handOff) persistIntegrationsManifest(handOff, ctx.sessionId);
  }
  return result;
}

async function fetchAndPersist(
  ctx: RefreshManifestCtx,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<RefreshManifestResult> {
  const url = `${resolveApiBaseUrl()}/api/plugin/integrations/manifest`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Plugin-Auth-Token': ctx.pluginAuthToken },
      body: JSON.stringify({
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        ...(ctx.agent ? { agent: ctx.agent } : {}),
      }),
      signal: ac.signal,
    });
    if (!resp.ok) {
      // An older backend without the endpoint answers 404 — the file on disk
      // stays authoritative, exactly as before this existed.
      return { status: 'skipped', reason: `HTTP ${resp.status}` };
    }
    const json = (await resp.json()) as { success?: boolean; data?: IntegrationsManifest };
    const fresh = json.data;
    if (!json.success || !fresh || !Array.isArray(fresh.integrations)) {
      return { status: 'skipped', reason: 'malformed response' };
    }
    const onDisk = readIntegrationsManifest(ctx.sessionId);
    const unchanged = onDisk !== null && fingerprint(onDisk) === fingerprint(fresh);
    // Equal to the shared hand-off is still "unchanged" — but the session
    // keeps its own copy from now on.
    if (unchanged && hasSessionIntegrationsManifest(ctx.sessionId)) return { status: 'unchanged' };
    persistIntegrationsManifest(fresh, ctx.sessionId);
    if (unchanged) return { status: 'unchanged' };

    const result: RefreshManifestResult = {
      status: 'rewritten',
      before: onDisk?.integrations.length ?? 0,
      after: fresh.integrations.length,
    };
    log.info(
      'integrations',
      `manifest refreshed from backend at start (${result.before} → ${result.after} entr${
        result.after === 1 ? 'y' : 'ies'
      }) — the on-disk copy was stale`,
    );
    return result;
  } catch (err) {
    return { status: 'skipped', reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
