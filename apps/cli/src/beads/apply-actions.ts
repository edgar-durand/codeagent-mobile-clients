import type { BeadsActionCommand } from '@codeam/shared';
import { BdAdapter } from './bd-adapter';
import { log } from '../services/logger';

/**
 * Apply a mobile-originated Beads action (relayed to the CLI as a pending
 * command) by running it as a NATIVE `bd` command, then trigger a push so the
 * resulting state flows back through the ingest watcher. The CLI is the only
 * writer to the home brain (station-canonical, D3); mobile actions are replayed
 * here, never written to the mirror directly.
 *
 * Mapping (verified flag surface, `@beads/bd@1.0.5`):
 *   claim    → `bd update <id> --claim [--owner <owner>]`
 *   close    → `bd close <id> [--reason <reason>]`
 *   create   → `bd create <title>`
 *   remember → `bd remember <body>`
 *
 * After a successful command, `onApplied()` is invoked (typically the
 * watcher's `syncNow`) to push the new snapshot immediately — bd's auto-export
 * also re-fires the file watcher, but an explicit push makes the round-trip
 * deterministic instead of racing the filesystem event.
 */

export interface ApplyActionDeps {
  adapter: BdAdapter;
  /** Push the resulting state (e.g. BeadsWatcher.syncNow). */
  onApplied: () => Promise<void>;
}

export interface ApplyActionResult {
  ok: boolean;
  /** Stable command name for logs / telemetry. */
  action: BeadsActionCommand['kind'];
  /** bd exit code (or -1 when the command couldn't be built / spawned). */
  code: number;
  /** Reason when ok=false. */
  error?: string;
}

/**
 * Translate an action into bd argv. Returns null when the action is malformed
 * (missing the field its kind requires) so the caller can reject it without
 * spawning bd.
 */
export function buildBdArgs(action: BeadsActionCommand): string[] | null {
  switch (action.kind) {
    case 'claim': {
      if (!action.issueId) return null;
      const args = ['update', action.issueId, '--claim'];
      if (action.owner) args.push('--owner', action.owner);
      return args;
    }
    case 'close': {
      if (!action.issueId) return null;
      const args = ['close', action.issueId];
      if (action.reason) args.push('--reason', action.reason);
      return args;
    }
    case 'create': {
      const title = action.text?.trim();
      if (!title) return null;
      return ['create', title];
    }
    case 'remember': {
      const body = action.text?.trim();
      if (!body) return null;
      return ['remember', body];
    }
    default:
      return null;
  }
}

export async function applyBeadsAction(
  action: BeadsActionCommand,
  deps: ApplyActionDeps,
): Promise<ApplyActionResult> {
  const args = buildBdArgs(action);
  if (!args) {
    log.warn('beads', `malformed beads action: kind=${action.kind}`);
    return { ok: false, action: action.kind, code: -1, error: 'malformed action' };
  }

  if (!deps.adapter.isAvailable()) {
    return { ok: false, action: action.kind, code: -1, error: 'bd unavailable' };
  }

  const res = await deps.adapter.run(args);
  if (res.code !== 0) {
    log.warn('beads', `bd ${args.join(' ')} failed (code=${res.code}): ${res.stderr.slice(0, 200)}`);
    return { ok: false, action: action.kind, code: res.code, error: res.stderr };
  }

  log.info('beads', `applied action ${action.kind}${action.issueId ? ` (${action.issueId})` : ''}`);

  // Push the resulting state. A push failure does NOT fail the action — the
  // bd mutation already landed on the station (source of truth); the next
  // feed event / heartbeat re-pushes.
  try {
    await deps.onApplied();
  } catch (err) {
    log.warn('beads', 'post-action push failed (state still applied locally)', err);
  }

  return { ok: true, action: action.kind, code: 0 };
}
