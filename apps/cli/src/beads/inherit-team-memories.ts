import { resolveApiBaseUrl } from '@codeagent/shared';
import { _transport } from '../services/file-watcher/transport';
import { log } from '../services/logger';
import type { BdAdapter } from './bd-adapter';

interface TeamMemory {
  id: string;
  body: string;
}

/**
 * Beads P3b — pull the user's team-inherited memories (owner-authored on the
 * backend) and write them into the ACTIVE repo's Beads DB so the agent's
 * `bd prime` surfaces them. Idempotent via `bd remember --key team-<id>`
 * (update-in-place), so re-provisions never duplicate. Strictly non-fatal — a
 * failure just means no inherited team context this session.
 *
 * Why the active-repo DB (not a personal/global prefix): verified on bd 1.0.5
 * that NEITHER `repos.additional` (bd repo sync) NOR `--global` memories
 * surface in `bd prime` — and `bd prime` is the agent's ingestion hook. Writing
 * into the active prefix DB is the only path that reaches the agent. Reuses the
 * watcher's plugin-auth transport + the bd adapter; creates nothing global.
 */
export async function inheritTeamMemories(opts: {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  adapter: BdAdapter;
  apiBaseUrl?: string;
}): Promise<void> {
  const apiBase = opts.apiBaseUrl ?? resolveApiBaseUrl();
  let memories: TeamMemory[] = [];
  try {
    const res = await _transport.post(
      `${apiBase}/api/beads/team-memories`,
      {
        'Content-Type': 'application/json',
        'X-Codeam-Protocol-Version': '2.0.0',
        'X-Plugin-Auth-Token': opts.pluginAuthToken,
      },
      JSON.stringify({ sessionId: opts.sessionId, pluginId: opts.pluginId }),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      log.trace('beads', `team-memories fetch status=${res.statusCode}`);
      return;
    }
    const parsed = JSON.parse(res.body) as { data?: { memories?: TeamMemory[] } };
    memories = Array.isArray(parsed.data?.memories) ? parsed.data!.memories! : [];
  } catch (err) {
    log.warn('beads', 'team-memories fetch failed (non-fatal)', err);
    return;
  }

  if (memories.length === 0) return;
  let written = 0;
  for (const m of memories) {
    const body = (m?.body ?? '').trim();
    if (!m?.id || !body) continue;
    try {
      // Stable key → idempotent across re-provisions; the label marks it as
      // owner-authored team context the agent should treat as read-only.
      await opts.adapter.run(['remember', '--key', `team-${m.id}`, `Team convention (read-only): ${body}`]);
      written++;
    } catch (err) {
      log.trace('beads', `team memory write failed id=${m.id}: ${(err as Error).message}`);
    }
  }
  log.info('beads', `inherited ${written}/${memories.length} team memory(ies) into the active repo`);
}
