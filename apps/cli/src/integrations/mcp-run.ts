// src/integrations/mcp-run.ts
//
// `codeam mcp-run <id>` — a HIDDEN command (not in help/suggest; it's a shim
// launched BY the agent's own MCP client config, never typed by a human).
// It resolves the integration's stdio MCP delivery spec, ensures the launcher
// binary is available (best-effort, `uvx` only), brokers a short-lived token
// for it via `IntegrationTokenClient`, and hands both to
// `RestartableStdioProxy`, which keeps the child's token fresh for the
// lifetime of the MCP session without the agent's MCP client ever seeing a
// hiccup.
import { execFileSync, execSync } from 'node:child_process';
import { LAUNCHER_ENV } from './launcher-env';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readIntegrationsManifest } from './manifest';
import { IntegrationTokenClient } from './token-client';
import { RestartableStdioProxy } from './stdio-proxy';
import { getIntegration, isKnownIntegrationId } from '@codeam/shared';
import type { BrokeredIntegrationToken, IntegrationMcpDelivery } from '@codeam/shared';

const RESTART_AHEAD_MS = 5 * 60 * 1000;

export function resolveDelivery(id: string): IntegrationMcpDelivery | null {
  // Manifest first (data-driven — backend-resolved spec wins), bundled registry fallback.
  const fromRegistry = isKnownIntegrationId(id) ? (getIntegration(id).delivery.mcp ?? null) : null;
  const fromManifest = readIntegrationsManifest()?.integrations.find((e) => e.id === id)?.delivery
    .mcp;
  if (fromManifest) {
    // Rollout defense: a backend still pinned to a pre-staticEnv @codeam/shared
    // emits manifests WITHOUT staticEnv. For known ids, merge the bundled
    // registry's staticEnv UNDERNEATH the manifest's (manifest values win) so
    // the server still gets its boot flags (jira's ATLASSIAN_OAUTH_ENABLE=true).
    if (fromRegistry?.staticEnv) {
      return {
        ...fromManifest,
        staticEnv: { ...fromRegistry.staticEnv, ...fromManifest.staticEnv },
      };
    }
    return fromManifest;
  }
  return fromRegistry;
}

/**
 * OS-agnostic command probe: `where` on Windows, `which` elsewhere. Mirrors
 * `defaultGitToolingRunner.which` in `commands/host/git-tooling.ts` —
 * `execFileSync` (no shell) avoids both the Windows-incompatibility and the
 * shell-injection surface of `execSync('command -v ...', { shell: '/bin/bash' })`.
 */
function commandExists(command: string): boolean {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(probe, [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Per-user bin dirs the uv installers drop binaries into — the host-agent's
 *  PATH (a systemd unit or a bare login shell) usually does NOT include them,
 *  so resolution must check them explicitly rather than trust `which`. */
export function localBinCandidates(command: string): string[] {
  return [
    path.join(os.homedir(), '.local', 'bin', command),
    path.join(os.homedir(), '.cargo', 'bin', command),
  ];
}

/**
 * Resolve the launcher to something spawnable: the bare command when it's on
 * PATH, else the absolute path of a per-user install (`~/.local/bin`,
 * `~/.cargo/bin`). Falls back to the bare command (spawn will ENOENT and the
 * proxy surfaces it) when nothing resolves.
 */
export function resolveLauncherPath(
  command: string,
  deps: { commandExists: (c: string) => boolean; existsSync: (p: string) => boolean } = {
    commandExists,
    existsSync,
  },
): string {
  if (deps.commandExists(command)) return command;
  for (const candidate of localBinCandidates(command)) {
    if (deps.existsSync(candidate)) return candidate;
  }
  return command;
}

/**
 * Best-effort launcher bootstrap. 2026-07-15 fleet-1 incident: a fresh
 * Ubuntu 24.04 self-hosted box has NO pip (`python3 -m pip` → "No module
 * named pip") and is PEP-668 externally-managed, so the old pip-only
 * attempt failed silently and the Jira MCP server (`uvx mcp-atlassian`)
 * ENOENT'd — the agent just answered "no tengo acceso a Jira". Order now:
 * official standalone installer (no python dependency at all) first, pip
 * as the fallback for distros that do ship it. All installer output goes
 * to stderr — stdout is the live MCP protocol channel.
 */
function ensureCommand(command: string): void {
  if (resolveLauncherPath(command) !== command || commandExists(command)) return;
  if (process.platform === 'win32') {
    // No POSIX-only shell fallback on Windows — surface a clear error and
    // let the child spawn fail with ENOENT rather than silently no-op.
    process.stderr.write(
      `[codeam mcp-run] '${command}' not found on PATH — install it and retry.\n`,
    );
    return;
  }
  if (command === 'uvx') {
    try {
      execSync('curl -LsSf https://astral.sh/uv/install.sh | sh', {
        stdio: ['ignore', process.stderr, process.stderr],
        timeout: 180_000,
        env: { ...process.env, UV_NO_MODIFY_PATH: '1' },
      });
    } catch {
      /* try pip next */
    }
    if (resolveLauncherPath(command) !== command) return;
    try {
      execSync('python3 -m pip install --user --quiet uv', {
        stdio: ['ignore', process.stderr, process.stderr],
        timeout: 180_000,
      });
    } catch {
      /* surface below */
    }
    if (resolveLauncherPath(command) !== command) return;
    process.stderr.write(
      `[codeam mcp-run] could not provision '${command}' (standalone installer + pip both failed) — the '${command}'-launched MCP server will be unavailable.\n`,
    );
  }
}

/**
 * The env the integration server is spawned with: our launcher defaults first
 * (`LAUNCHER_ENV`), then the registry's static boot flags, then the brokered
 * credential mapping — the credential wins on any collision.
 */
export function childEnvFor(
  delivery: IntegrationMcpDelivery,
  token: BrokeredIntegrationToken,
): Record<string, string> {
  const env: Record<string, string> = { ...LAUNCHER_ENV, ...delivery.staticEnv };
  for (const [envVar, field] of Object.entries(delivery.envMapping)) {
    const value = token[field as keyof BrokeredIntegrationToken];
    if (typeof value === 'string' && value) env[envVar] = value;
  }
  return env;
}

export async function mcpRun(args: string[]): Promise<void> {
  const id = args[0] ?? process.env.CODEAM_MCP_INTEGRATION_ID;
  const sessionId = process.env.CODEAM_MCP_SESSION_ID;
  const pluginId = process.env.CODEAM_MCP_PLUGIN_ID;
  const pluginAuthToken = process.env.CODEAM_MCP_PLUGIN_TOKEN;
  if (!id || !sessionId || !pluginId || !pluginAuthToken) {
    process.stderr.write('[codeam mcp-run] missing integration id or session credentials in env\n');
    process.exit(1);
  }
  const delivery = resolveDelivery(id);
  if (!delivery) {
    process.stderr.write(`[codeam mcp-run] no mcp delivery for '${id}'\n`);
    process.exit(1);
  }

  // Built-in delivery — a codeam-authored MCP server (not a spawned child, not
  // a remote relay). Convex needs this: its own `convex mcp start` rejects every
  // headless credential (interactive login only), so we serve the Convex tools
  // ourselves against the deployment's admin REST API with the brokered deploy
  // key. `command`/`args` are empty for these.
  if (delivery.builtin === 'convex-admin') {
    const client = new IntegrationTokenClient({
      sessionId,
      pluginId,
      pluginAuthToken,
      pollSecret: process.env.CODEAM_MCP_POLL_SECRET,
    });
    const { runConvexAdminMcp } = await import('./convex-admin-mcp');
    await runConvexAdminMcp(client, id);
    return;
  }

  // HTTP-transport delivery (a hosted remote MCP, e.g. PostHog) — relay to it
  // over Streamable HTTP with the brokered token as a header, instead of
  // spawning a stdio child. `command` is empty for these.
  if (delivery.httpUrl) {
    const httpClient = new IntegrationTokenClient({
      sessionId,
      pluginId,
      pluginAuthToken,
      pollSecret: process.env.CODEAM_MCP_POLL_SECRET,
    });
    const { runHttpRelay } = await import('./http-relay');
    await runHttpRelay(delivery, httpClient, id);
    return;
  }

  ensureCommand(delivery.command);
  // Absolute path when the launcher lives in a per-user bin dir the
  // host-agent's PATH doesn't cover (systemd unit, fresh box).
  const launcher = resolveLauncherPath(delivery.command);
  const client = new IntegrationTokenClient({
    sessionId,
    pluginId,
    pluginAuthToken,
    pollSecret: process.env.CODEAM_MCP_POLL_SECRET,
  });

  let current: BrokeredIntegrationToken | null = null;
  const proxy = new RestartableStdioProxy({
    spawnSpec: async () => {
      current = await client.getToken(id);
      return { command: launcher, args: delivery.args, env: childEnvFor(delivery, current) };
    },
    shouldRestartNow: () =>
      current !== null && new Date(current.expiresAt).getTime() - Date.now() < RESTART_AHEAD_MS,
  });
  await proxy.start();
}
