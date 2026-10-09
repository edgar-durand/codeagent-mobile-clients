// src/integrations/manifest.ts
//
// Persistence for the Agent Toolkits integrations manifest the CLI reads on
// every deploy/spawn — the set of integrations (delivery shape only, never
// secrets) wired for a session. Write mechanics (atomic tmp+rename, 0600,
// best-effort logging) mirror `src/commands/host/house-proxy-config.ts`.
//
// ⚠️ ONE FILE PER SESSION (codeagent-sjk b). A self-hosted box runs several
// deploys side by side, and they all used to share `~/.codeam/integrations.json`:
// every deploy, start-time refresh and `integrations_sync` overwrote it (a
// deploy without integrations DELETED it), so session A's next `mcp-run` /
// `mcp-router` spawn read session B's set. Now every reader and writer that
// knows its session uses `integrations-<sessionId>.json`. The un-keyed file is
// only the deploy hand-off (host-agent writes it before the session exists) and
// the fallback for a session that has no file of its own yet.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IntegrationsManifest } from '@codeam/shared';
import { log } from '../services/logger';
import { restrictToOwner } from '../lib/restrict-to-owner';

/** A session id is only trusted as a file-name segment when it looks like one. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function sessionKey(sessionId: string | null | undefined): string | null {
  return sessionId && SESSION_ID_RE.test(sessionId) ? sessionId : null;
}

/** The session's own manifest path, or the shared hand-off file without a usable id. */
export function integrationsManifestPath(sessionId?: string | null): string {
  const key = sessionKey(sessionId);
  return path.join(os.homedir(), '.codeam', key ? `integrations-${key}.json` : 'integrations.json');
}

function readFile(file: string): IntegrationsManifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as IntegrationsManifest;
    if (!Array.isArray(raw?.integrations)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** True when this session already owns a manifest file. */
export function hasSessionIntegrationsManifest(sessionId: string | null | undefined): boolean {
  return sessionKey(sessionId) !== null && fs.existsSync(integrationsManifestPath(sessionId));
}

/**
 * Best-effort read: the session's own file, else the shared hand-off file.
 * Missing file or invalid JSON/shape → null (integrations off).
 */
export function readIntegrationsManifest(sessionId?: string | null): IntegrationsManifest | null {
  if (hasSessionIntegrationsManifest(sessionId)) {
    return readFile(integrationsManifestPath(sessionId));
  }
  return readFile(integrationsManifestPath());
}

/**
 * Persist the manifest atomically (write a temp file, then rename) so a
 * concurrent reader never sees a half-written file. Best-effort: a failure to
 * persist is logged and swallowed — it must NEVER break the deploy.
 */
export function persistIntegrationsManifest(m: IntegrationsManifest, sessionId?: string | null): void {
  try {
    const file = integrationsManifestPath(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    restrictToOwner(file);
  } catch (err) {
    log.warn(
      'integrations',
      `failed to persist integrations manifest (best-effort): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Remove a manifest (e.g. a deploy with zero integration selections). Best-effort. */
export function clearIntegrationsManifest(sessionId?: string | null): void {
  try {
    fs.rmSync(integrationsManifestPath(sessionId), { force: true });
  } catch {
    // best-effort
  }
}
