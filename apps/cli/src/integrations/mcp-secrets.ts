// src/integrations/mcp-secrets.ts
//
// Secrets for the MCP servers we hand the agent, kept OFF every command line.
//
// ⚠️ WHY (codeagent-5bew, QA box 2026-09-25): we give the ACP adapter each MCP
// server with its credentials in `env`, precisely so they never reach argv —
// but `@agentclientprotocol/claude-agent-acp` serializes the WHOLE config,
// env included, into the `claude` binary's `--mcp-config '{…}'` argument. The
// plugin token, the poll secret and the preview-bridge token were all readable
// in `ps` inside the box. We don't own that adapter, so the fix is to put no
// secret in the env it sees: the env carries only the PATH of an owner-only
// file, and our own shims (`mcp-run`, `mcp-router`, `preview-mcp`) read the
// values from it at startup.
//
// One file per CLI process (one session) and per scope (integrations,
// preview) — each server entry names its own file, and a write REPLACES it,
// so a credential can never linger from an earlier write. Owner-only (0600 in
// a 0700 dir), removed on exit; files left by a crashed process are pruned the
// next time any CLI writes one.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const MCP_SECRETS_FILE_ENV = 'CODEAM_MCP_SECRETS_FILE';

export function mcpSecretsDir(): string {
  return path.join(os.homedir(), '.codeam', 'mcp-secrets');
}

export type McpSecretScope = 'integrations' | 'preview';

export function mcpSecretsPath(scope: McpSecretScope, pid: number = process.pid): string {
  return path.join(mcpSecretsDir(), `${pid}-${scope}.json`);
}

const registeredForCleanup = new Set<string>();

function readFileVars(file: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = alive but not ours; only ESRCH means gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Remove files left behind by CLI processes that no longer exist. */
function pruneStale(dir: string): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = /^(\d+)-[a-z]+\.json$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || pidAlive(pid)) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      /* raced with another pruner */
    }
  }
}

/**
 * Write `vars` as the whole content of `file` and return its path, or null
 * when it could not be written (callers then fall back to inline env — a
 * working agent beats a hidden token).
 */
export function writeMcpSecrets(vars: Record<string, string>, file: string): string | null {
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    pruneStale(dir);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(vars), { mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
    if (!registeredForCleanup.has(file)) {
      registeredForCleanup.add(file);
      process.once('exit', () => {
        try {
          fs.unlinkSync(file);
        } catch {
          /* already gone */
        }
      });
    }
    return file;
  } catch {
    return null;
  }
}

/**
 * The env entries an MCP server gets for `vars`: just the file's path when it
 * could be written, the values themselves otherwise.
 */
export function mcpSecretEnv(
  scope: McpSecretScope,
  vars: Record<string, string>,
): Array<{ name: string; value: string }> {
  const file = writeMcpSecrets(vars, mcpSecretsPath(scope));
  if (file) return [{ name: MCP_SECRETS_FILE_ENV, value: file }];
  return Object.entries(vars).map(([name, value]) => ({ name, value }));
}

/**
 * Shim side: fill `env` from the secrets file named in it. A value already in
 * the env wins (an explicit override, or the inline fallback).
 */
export function loadMcpSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const file = env[MCP_SECRETS_FILE_ENV];
  if (!file) return;
  for (const [k, v] of Object.entries(readFileVars(file))) {
    if (env[k] === undefined) env[k] = v;
  }
}
