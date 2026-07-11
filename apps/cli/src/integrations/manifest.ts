// src/integrations/manifest.ts
//
// Persistence for the Agent Toolkits integrations manifest the CLI reads on
// every deploy/spawn: ~/.codeam/integrations.json — the set of integrations
// (delivery shape only, never secrets) a deploy wired for this session.
// Write mechanics (atomic tmp+rename, 0600, best-effort logging) mirror
// `src/commands/host/headroom-config.ts` byte-for-byte.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IntegrationsManifest } from '@codeam/shared';
import { log } from '../services/logger';
import { restrictToOwner } from '../lib/restrict-to-owner';

export function integrationsManifestPath(): string {
  return path.join(os.homedir(), '.codeam', 'integrations.json');
}

/** Best-effort read: missing file or invalid JSON/shape → null (integrations off). */
export function readIntegrationsManifest(): IntegrationsManifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(integrationsManifestPath(), 'utf8')) as IntegrationsManifest;
    if (!Array.isArray(raw?.integrations)) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Persist the manifest atomically (write a temp file, then rename) so a
 * concurrent reader never sees a half-written file. Best-effort: a failure to
 * persist is logged and swallowed — it must NEVER break the deploy.
 */
export function persistIntegrationsManifest(m: IntegrationsManifest): void {
  try {
    const file = integrationsManifestPath();
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

/** Remove the manifest (e.g. a deploy with zero integration selections). Best-effort. */
export function clearIntegrationsManifest(): void {
  try {
    fs.rmSync(integrationsManifestPath(), { force: true });
  } catch {
    // best-effort
  }
}
