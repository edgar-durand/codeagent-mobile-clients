import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Strip the RETIRED Headroom proxy config out of the global
 * `~/.claude/settings.json`.
 *
 * ## The incident (edgar-ph, 2026-09-19)
 *
 * A PR agent-review deployed, paired, received its `start_task` and forwarded
 * the 2368-char review prompt to Claude Code — and then died 176 s later with
 *
 *   API Error: Connection refused — a firewall or proxy may be blocking it
 *
 * Nothing was blocking it. `~/.claude/settings.json` still carried
 * `env.ANTHROPIC_BASE_URL = http://127.0.0.1:8787`, the local Headroom
 * compression proxy. Headroom was retired from the product, so nothing listens
 * on 8787 any more: Claude Code dialled a dead socket on every turn. The error
 * says "firewall or proxy", which reads like a network problem and is in fact
 * the opposite — nobody home.
 *
 * ## Why it survived the retirement
 *
 * Removing Headroom changed the image and the code. It did NOT change the
 * DISK of boxes that already existed, and `~` on a fleet box / warm codespace
 * is a persistent volume that outlives any bake — the same shadowing that
 * forces `ensureBeadsWorkflowHint` to be a runtime write. The affected box was
 * created 2026-07-27 and had been poisoned ever since; a box created today is
 * clean, because no code writes this key any more. That asymmetry is exactly
 * why the fix has to run on EVERY session start rather than at provision time.
 *
 * ⚠️ **Surgical on purpose.** `ANTHROPIC_BASE_URL` is a legitimate setting
 * elsewhere — the managed agent-proxy (`<api>/api/v1/agent-proxy`) and the
 * house proxy both set it, and wiping those would break paid inference. Only a
 * value pointing at the retired Headroom port is removed; anything else is left
 * exactly as it is.
 *
 * Idempotent, best-effort, never throws: a malformed settings.json must not
 * stop a session from starting.
 */

/** The retired Headroom proxy. Matched by host:port, so `localhost` and
 *  `127.0.0.1` both count, with or without a trailing slash or path.
 *
 *  ⚠️ The port must END the authority (`/`, `?`, `#` or end-of-string) — a
 *  `\b` here also matched `https://127.0.0.1:8787.evil.example.com`, i.e. a
 *  hostname that merely STARTS with the loopback literal. On a rule whose false
 *  positive deletes a live inference endpoint, the conservative anchor wins. */
const RETIRED_PROXY_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):8787(?:[/?#]|$)/i;

/** A hook command that shells out to the retired binary. */
const HEADROOM_CMD_RE = /(^|[\s/"'])headroom(\s|$)/i;

const MARKETPLACE_KEY = 'headroom-marketplace';

interface HookEntry {
  command?: unknown;
  [k: string]: unknown;
}
interface HookMatcher {
  hooks?: HookEntry[];
  [k: string]: unknown;
}

/** True when this hook group shells out to the retired binary. */
function isHeadroomHook(group: HookMatcher): boolean {
  return (group.hooks ?? []).some(
    (h) => typeof h?.command === 'string' && HEADROOM_CMD_RE.test(h.command),
  );
}

export interface RetiredProxyCleanupResult {
  /** The file existed and parsed. */
  inspected: boolean;
  /** Something was removed and the file was rewritten. */
  changed: boolean;
  /** What was dropped — for the caller's log line. */
  removed: string[];
}

export function sanitizeRetiredProxyConfig(
  homeDir: string = os.homedir(),
): RetiredProxyCleanupResult {
  const out: RetiredProxyCleanupResult = { inspected: false, changed: false, removed: [] };
  const file = path.join(homeDir, '.claude', 'settings.json');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // Absent or unreadable/malformed — nothing to do, and never a reason to
    // fail a session start.
    return out;
  }
  if (!parsed || typeof parsed !== 'object') return out;
  out.inspected = true;

  // 1. The base URL — the one that actually breaks every turn.
  const env = parsed.env;
  if (env && typeof env === 'object') {
    const envRec = env as Record<string, unknown>;
    const base = envRec.ANTHROPIC_BASE_URL;
    if (typeof base === 'string' && RETIRED_PROXY_RE.test(base.trim())) {
      delete envRec.ANTHROPIC_BASE_URL;
      out.removed.push('env.ANTHROPIC_BASE_URL');
      out.changed = true;
      // Drop an env block that only existed to hold it.
      if (Object.keys(envRec).length === 0) delete parsed.env;
    }
  }

  // 2. The plugin marketplace entry — inert, but it is dangling config that
  //    makes the next reader think Headroom is still a thing.
  const mkts = parsed.extraKnownMarketplaces;
  if (mkts && typeof mkts === 'object' && MARKETPLACE_KEY in (mkts as object)) {
    delete (mkts as Record<string, unknown>)[MARKETPLACE_KEY];
    out.removed.push(`extraKnownMarketplaces.${MARKETPLACE_KEY}`);
    out.changed = true;
    if (Object.keys(mkts as object).length === 0) delete parsed.extraKnownMarketplaces;
  }

  // 3. The hooks. These currently exit 0 (the python package lingers), so they
  //    are not the outage — but they run on EVERY Bash tool use and every
  //    session start, and they will start failing the day the package goes.
  const hooks = parsed.hooks;
  if (hooks && typeof hooks === 'object') {
    const hookRec = hooks as Record<string, unknown>;
    for (const [event, groups] of Object.entries(hookRec)) {
      if (!Array.isArray(groups)) continue;
      const kept = (groups as HookMatcher[]).filter((g) => !isHeadroomHook(g));
      if (kept.length !== groups.length) {
        out.removed.push(`hooks.${event}`);
        out.changed = true;
        if (kept.length) hookRec[event] = kept;
        else delete hookRec[event];
      }
    }
    if (Object.keys(hookRec).length === 0) delete parsed.hooks;
  }

  if (!out.changed) return out;

  // Atomic replace: a half-written settings.json would break every future
  // Claude Code start, which is strictly worse than the bug being fixed.
  try {
    const tmp = `${file}.codeam.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    out.changed = false;
  }
  return out;
}
