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

/** Best-effort: uvx ships via `uv`; codespaces have pip (headroom precedent). */
function ensureCommand(command: string): void {
  if (commandExists(command)) return;
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
      execSync('python3 -m pip install --user --quiet uv', { stdio: 'inherit', timeout: 180_000 });
    } catch {
      /* surface at spawn */
    }
  }
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

  ensureCommand(delivery.command);
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
      // Static boot flags first; the credential mapping wins on any collision.
      const env: Record<string, string> = { ...delivery.staticEnv };
      for (const [envVar, field] of Object.entries(delivery.envMapping)) {
        const value = current[field as keyof BrokeredIntegrationToken];
        if (typeof value === 'string' && value) env[envVar] = value;
      }
      return { command: delivery.command, args: delivery.args, env };
    },
    shouldRestartNow: () =>
      current !== null && new Date(current.expiresAt).getTime() - Date.now() < RESTART_AHEAD_MS,
  });
  await proxy.start();
}
