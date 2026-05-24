import pc from 'picocolors';
import { DEFAULT_API_BASE_URL } from '@codeagent/shared';
import { clearAll, loadCliConfig } from '../config';
import { showIntro } from '../ui/banner';
import { confirmAction } from '../ui/prompts';
import { _postJson } from '../services/pairing.service';
import { log } from '../services/logger';

const API_BASE = process.env.CODEAM_API_URL ?? DEFAULT_API_BASE_URL;

/**
 * Best-effort offline-heartbeat fan-out before tearing down local
 * state (#67 / audit CLI finding 20). Without this, the backend
 * keeps showing each paired session as "online" for ~30 s until
 * the heartbeat-timeout fires, so the mobile app's session picker
 * shows the just-logged-out CLI as still live. We POST in parallel
 * with a hard 3 s deadline — slow / unreachable backend can't
 * block the logout UX.
 */
async function notifyBackendOffline(): Promise<void> {
  const cfg = loadCliConfig();
  const pluginIds = new Set<string>([
    cfg.pluginId,
    ...cfg.sessions.map((s) => s.pluginId).filter((id): id is string => Boolean(id)),
  ]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    await Promise.all(
      Array.from(pluginIds).map((pluginId) =>
        _postJson(`${API_BASE}/api/plugin/heartbeat`, {
          pluginId,
          online: false,
        }).catch((err: unknown) => {
          log.trace('logout', `heartbeat-offline failed pluginId=${pluginId}`, err);
        }),
      ),
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function logout(): Promise<void> {
  showIntro();
  const ok = await confirmAction('Remove all sessions and local config?');
  if (!ok) { console.log(''); return; }

  // Notify the backend BEFORE clearing local state so we still have
  // the pluginIds to address. Best-effort: failures (network, 5xx)
  // don't block the logout — the user wanted out, and the backend
  // will eventually reap stale sessions via heartbeat-timeout anyway.
  await notifyBackendOffline();

  clearAll();
  console.log(pc.green('\n  ✓ Done. All sessions removed.\n'));
}
