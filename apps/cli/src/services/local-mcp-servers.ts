// src/services/local-mcp-servers.ts
//
// Box-local custom MCP servers — `~/.codeam/mcp-servers.json`. ACP sessions
// pass `mcpServers` explicitly on `session/new` (see `AcpClient` in
// `agents/acp/client.ts`), which OVERRIDES the agent's own native MCP config
// (e.g. `~/.codex/config.toml`) rather than merging with it. That means an
// MCP server a self-hosted box owner configured for their agent directly
// never reaches a relayed session. This file lets the owner declare the same
// kind of server for the CLI to inject itself, so it survives the override.
//
// Pure/synchronous file work, same shape as `integrations/provision.ts`'s
// `buildMcpServersForStart` (which this is merged with at the single
// composition point in `commands/start.ts`) — never throws, never blocks
// session start. Any miss (no file, malformed JSON, invalid entries) simply
// yields fewer/zero servers; the caller always gets a valid array back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@agentclientprotocol/sdk';
import { log } from './logger';

/** Raw on-disk shape the box owner hand-writes or scripts into place. */
interface RawLocalMcpServer {
  name?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
}

/** Hard cap so a mis-authored file can't balloon every ACP session's spawn. */
const MAX_LOCAL_MCP_SERVERS = 10;

export function localMcpServersPath(): string {
  return path.join(os.homedir(), '.codeam', 'mcp-servers.json');
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === 'string');
}

/** `undefined` env (not present) is valid — `null`/non-object/non-string-values are not. */
function toEnvVariables(v: unknown): { name: string; value: string }[] | null {
  if (v === undefined) return [];
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.some(([, value]) => typeof value !== 'string')) return null;
  return entries.map(([name, value]) => ({ name, value: value as string }));
}

interface ValidatedLocalMcpServer {
  name: string;
  command: string;
  args: string[];
  env?: unknown;
}

function isValidEntry(entry: RawLocalMcpServer): entry is ValidatedLocalMcpServer {
  return (
    typeof entry.name === 'string' &&
    entry.name.length > 0 &&
    typeof entry.command === 'string' &&
    entry.command.length > 0 &&
    isStringArray(entry.args)
  );
}

/**
 * Reads `~/.codeam/mcp-servers.json` and returns the ACP `McpServer[]` spec
 * for each valid entry. Missing file → `[]` (the common case — no local
 * config). Malformed JSON / non-array top level / an entry that fails
 * validation → warned once per call (never per-entry, to avoid spamming the
 * log on a badly authored file) and skipped; this function never throws.
 */
export function readLocalMcpServers(): McpServer[] {
  let raw: string;
  try {
    raw = fs.readFileSync(localMcpServersPath(), 'utf8');
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(
      'localMcp',
      `~/.codeam/mcp-servers.json is not valid JSON — ignoring (${err instanceof Error ? err.message : String(err)})`,
    );
    return [];
  }

  if (!Array.isArray(parsed)) {
    log.warn('localMcp', '~/.codeam/mcp-servers.json must be a JSON array — ignoring');
    return [];
  }

  const servers: McpServer[] = [];
  let sawInvalid = false;
  let sawTruncated = false;
  for (const entry of parsed as RawLocalMcpServer[]) {
    if (servers.length >= MAX_LOCAL_MCP_SERVERS) {
      sawTruncated = true;
      continue;
    }
    if (entry === null || typeof entry !== 'object' || !isValidEntry(entry)) {
      sawInvalid = true;
      continue;
    }
    const env = toEnvVariables(entry.env);
    if (env === null) {
      sawInvalid = true;
      continue;
    }
    servers.push({ name: entry.name, command: entry.command, args: entry.args, env });
  }

  if (sawInvalid) {
    log.warn(
      'localMcp',
      '~/.codeam/mcp-servers.json contains one or more invalid entries — skipped ' +
        '(each needs a non-empty "name", non-empty "command", "args" as a string array, ' +
        'and "env" as an object of string values)',
    );
  }
  if (sawTruncated) {
    log.warn(
      'localMcp',
      `~/.codeam/mcp-servers.json has more than ${MAX_LOCAL_MCP_SERVERS} entries — only the first ${MAX_LOCAL_MCP_SERVERS} were loaded`,
    );
  }
  if (servers.length) {
    log.info(
      'localMcp',
      `loaded ${servers.length} local MCP server(s): ${servers.map((s) => s.name).join(', ')}`,
    );
  }
  return servers;
}

/**
 * The single merge policy shared by every composition point that builds the
 * final `mcpServers` list for a session (session start in `commands/start.ts`,
 * and the mid-session `integrations_sync` respawn in
 * `agents/acp/command-handlers.ts`): Agent Toolkit integration servers first,
 * then box-local servers appended — on a `name` collision the integration
 * wins (it's per-user, backend-managed) and the local duplicate is dropped
 * with a warning rather than silently shadowing it.
 */
export function mergeWithLocalMcpServers(integrationServers: McpServer[]): McpServer[] {
  const localServers = readLocalMcpServers();
  if (localServers.length === 0) return integrationServers;

  const integrationNames = new Set(integrationServers.map((s) => s.name));
  const merged = [...integrationServers];
  for (const local of localServers) {
    if (integrationNames.has(local.name)) {
      log.warn(
        'localMcp',
        `local MCP server "${local.name}" collides with an Agent Toolkit integration of the same name — the integration wins, skipping the local entry`,
      );
      continue;
    }
    merged.push(local);
  }
  return merged;
}
