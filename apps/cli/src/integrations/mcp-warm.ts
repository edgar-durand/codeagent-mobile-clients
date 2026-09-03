// src/integrations/mcp-warm.ts
//
// `codeam mcp-warm` — download every integration MCP server ahead of time, so
// the agent never pays for it.
//
// ⚠️ WHY THIS EXISTS. The agent starts EVERY advertised MCP server inside
// `session/new` and gives each one a fixed budget (`MCP_TIMEOUT`, 30 s by
// default — see `MCP_STARTUP_TIMEOUT_MS` in `agents/acp/client.ts`). Our
// servers are launched through the `codeam mcp-run` shim, whose first start has
// to fetch the vendor's package — `npx -y <pkg>@<version>`, i.e. a DOWNLOAD —
// before the server can even begin its handshake. With a dozen integrations
// linked, all racing on one core, the slow ones simply run out of budget and
// the agent files them as `Server "<id>" is not connected`, with no retry for
// the rest of the session (rafaelph90.br@gmail.com, 2026-09-03: clickup,
// trello and postman all dead this way while `session/new` reported ok).
//
// Raising the budget stops a healthy-but-slow server from being declared dead.
// This removes the reason it was slow. The download belongs in the image build,
// next to the CLI, the agents and Headroom's model — the Dockerfile already
// states the rule for pglite: "Instalado en la imagen y no al vuelo porque
// bajarlo en el primer preview metería su descarga en el camino crítico del
// usuario".
//
// ⚠️ THE LIST IS NOT DUPLICATED HERE. It is derived from the SAME registry the
// shim resolves at runtime (`@codeam/shared`), so an integration added or
// re-pinned there is warmed automatically. A second copy in the Dockerfile
// would drift the moment someone bumped a version — and a warmed cache for the
// WRONG version is worse than none, because it looks warm and still downloads.
import { spawnSync } from 'node:child_process';
import { getEnabledIntegrations, type IntegrationMcpDelivery } from '@codeam/shared';
import { log } from '../services/logger';

/** One package to warm, as the runtime will ask for it. */
export interface WarmTarget {
  /** Integration id — for reporting only. */
  id: string;
  /** The launcher the shim will use (`npx` / `uvx`). */
  launcher: string;
  /**
   * The launcher flags that PRECEDE the package in the delivery (`-y`,
   * `--ignore-scripts`, …). ⚠️ Carried through so the warm invocation matches
   * the runtime one: postman only installs under `--ignore-scripts` (its
   * `preinstall` is an `only-allow pnpm` guard), and warming it without the
   * flag fails while the runtime would have succeeded — or worse, the reverse.
   */
  flags: string[];
  /**
   * The exact spec the runtime resolves. ⚠️ It must match the runtime's spec
   * CHARACTER FOR CHARACTER: npx keys its cache by the spec string, so
   * `pkg@1.2.3` and `pkg` are different entries and warming one does nothing
   * for the other. This is why the spec is read from the delivery's own args
   * rather than reconstructed.
   */
  spec: string;
}

/**
 * The package spec inside a delivery's args.
 *
 * `npx` deliveries look like `['-y', 'pkg@1.2.3', …flags]` and `uvx` ones like
 * `['mcp-atlassian==0.22.1']`, so the spec is the first argument that is not a
 * flag. Returns null for a delivery with no child to launch — the builtin and
 * HTTP-relay ones (posthog, vercel, convex, …) serve tools in-process and have
 * nothing to download.
 */
export function specOf(delivery: IntegrationMcpDelivery): string | null {
  if (!delivery.command) return null;
  const spec = (delivery.args ?? []).find((a) => !a.startsWith('-'));
  return spec ?? null;
}

/** The flags the delivery passes to the LAUNCHER — everything before the
 *  package spec. Flags that follow it belong to the server itself (figma's
 *  `--stdio`), and passing those to a warm run would be wrong. */
export function launcherFlagsOf(delivery: IntegrationMcpDelivery): string[] {
  const args = delivery.args ?? [];
  const specIndex = args.findIndex((a) => !a.startsWith('-'));
  return specIndex === -1 ? [...args] : args.slice(0, specIndex);
}

/** Every package the runtime could ask a launcher to fetch, de-duplicated by
 *  spec — jira and confluence share one `mcp-atlassian` pin, and warming it
 *  twice would just pay the same download twice. */
export function warmTargets(): WarmTarget[] {
  const bySpec = new Map<string, WarmTarget>();
  // ⚠️ ENABLED only, deliberately: warming a package for an integration the
  // product does not offer would pay for a download nobody can trigger.
  for (const integration of getEnabledIntegrations()) {
    const delivery = integration.delivery?.mcp;
    if (!delivery) continue;
    const spec = specOf(delivery);
    if (!spec) continue;
    if (!bySpec.has(spec)) {
      bySpec.set(spec, {
        id: integration.id,
        launcher: delivery.command,
        flags: launcherFlagsOf(delivery),
        spec,
      });
    }
  }
  return [...bySpec.values()];
}

/**
 * Populate a launcher's cache for one spec WITHOUT running the server.
 *
 * ⚠️ The server must not actually start. An MCP server speaks JSON-RPC over
 * stdio and blocks waiting for a client, so `npx -y <pkg>` would hang the build
 * forever. `npx --package=<spec> -c true` installs the package into the npx
 * cache and then runs `true` instead of its binary — same download, no server.
 * `uv` has a first-class equivalent in `uv tool install`.
 */
function warmCommand(target: WarmTarget): { command: string; args: string[] } | null {
  if (target.launcher === 'npx') {
    // The delivery's own launcher flags first (minus `-y`, which we always
    // pass), then `--package … -c true`.
    const extra = target.flags.filter((f) => f !== '-y');
    return { command: 'npx', args: ['-y', ...extra, '--package', target.spec, '-c', 'true'] };
  }
  if (target.launcher === 'uvx') {
    // `uvx pkg` runs the tool; `uv tool install` only puts it in the cache.
    return { command: 'uv', args: ['tool', 'install', target.spec] };
  }
  return null;
}

export interface WarmResult {
  warmed: string[];
  skipped: string[];
  failed: Array<{ spec: string; reason: string }>;
}

/**
 * Warm every registry MCP package. BEST-EFFORT BY DESIGN: a package that fails
 * here is downloaded at runtime exactly as it is today, so this must never fail
 * the build that calls it — the same contract the Dockerfile already uses for
 * the curl-installed agents ("a missing one is installed on first deploy —
 * NEVER fail the build").
 */
export async function mcpWarm(argv: string[] = []): Promise<void> {
  const timeoutMs = 300_000;
  const targets = warmTargets();
  const only = argv.filter((a) => !a.startsWith('-'));
  const selected = only.length > 0 ? targets.filter((t) => only.includes(t.id)) : targets;

  const result: WarmResult = { warmed: [], skipped: [], failed: [] };
  // eslint-disable-next-line no-console
  console.log(`[codeam mcp-warm] ${selected.length} MCP package(s) to pre-fetch`);

  for (const target of selected) {
    const cmd = warmCommand(target);
    if (!cmd) {
      result.skipped.push(`${target.spec} (no warm recipe for '${target.launcher}')`);
      continue;
    }
    const started = Date.now();
    const run = spawnSync(cmd.command, cmd.args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: timeoutMs,
      encoding: 'utf8',
    });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (run.status === 0) {
      result.warmed.push(target.spec);
      // eslint-disable-next-line no-console
      console.log(`  OK   ${target.spec} (${secs}s)`);
    } else {
      // ⚠️ Skip `npm warn` / `npm notice` lines. Taking the last stderr line
      // verbatim reported "npm warn deprecated @faker-js/faker@5.5.3" as the
      // reason postman failed, which HID the real cause (an `only-allow pnpm`
      // preinstall guard) behind a harmless warning and cost a detour to find.
      const noise = /^npm (warn|notice)\b/;
      const lines = (run.stderr ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !noise.test(l));
      const reason =
        run.error?.message ?? lines[lines.length - 1] ?? `exit ${String(run.status)} (no stderr)`;
      result.failed.push({ spec: target.spec, reason });
      // eslint-disable-next-line no-console
      console.log(`  MISS ${target.spec} (${secs}s) — fetched at runtime instead: ${reason}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[codeam mcp-warm] warmed=${result.warmed.length}` +
      ` failed=${result.failed.length} skipped=${result.skipped.length}`,
  );
  log.info(
    'mcpWarm',
    `warmed=${result.warmed.length} failed=${result.failed.length} skipped=${result.skipped.length}`,
  );
}
