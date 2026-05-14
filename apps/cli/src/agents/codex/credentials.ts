import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CloudProvider } from '../../services/providers/types';
import type { LocalCredentialSource } from '../strategy';

/**
 * Detects local Codex credentials in priority order:
 *   1. ~/.codex/auth.json (OAuth token, preferred — matches `codex login`)
 *   2. $OPENAI_API_KEY env var (API key fallback)
 */
export async function detectLocalCodexCredentials(): Promise<LocalCredentialSource> {
  const home = process.env.HOME ?? os.homedir();
  const authJson = path.join(home, '.codex', 'auth.json');
  if (fs.existsSync(authJson)) {
    return { source: 'flat-file', description: '~/.codex/auth.json' };
  }
  if (process.env.OPENAI_API_KEY) {
    return { source: 'env-var', description: 'OPENAI_API_KEY env var' };
  }
  return { source: 'none', description: '' };
}

/**
 * Upload the local credential to the remote codespace at the path Codex
 * reads from at runtime (~/.codex/auth.json for OAuth, ~/.bashrc export
 * for API key).
 */
export async function bridgeLocalCodexCredentials(
  provider: CloudProvider,
  workspaceId: string,
): Promise<LocalCredentialSource> {
  const home = process.env.HOME ?? os.homedir();
  const authJson = path.join(home, '.codex', 'auth.json');

  if (fs.existsSync(authJson)) {
    const contents = fs.readFileSync(authJson);
    await provider.exec(workspaceId, 'mkdir -p ~/.codex && chmod 700 ~/.codex');
    await provider.uploadFile(workspaceId, '/home/codespace/.codex/auth.json', contents, { mode: 0o600 });
    return { source: 'flat-file', description: '~/.codex/auth.json' };
  }

  const key = process.env.OPENAI_API_KEY;
  if (key) {
    const escaped = key.replace(/'/g, "'\\''");
    const line = `export OPENAI_API_KEY='${escaped}'`;
    await provider.exec(workspaceId, `grep -qxF "${line}" ~/.bashrc || echo "${line}" >> ~/.bashrc`);
    return { source: 'env-var', description: 'OPENAI_API_KEY env var' };
  }

  return { source: 'none', description: '' };
}

/**
 * `codex login` interactive flow on the workspace — fallback when no
 * local credentials were bridged. Drives the device-code OAuth flow
 * via SSH stdio inheritance.
 */
export async function runRemoteCodexLogin(
  provider: CloudProvider,
  workspaceId: string,
): Promise<void> {
  await provider.streamCommand(workspaceId, 'bash -lc "codex login"');
}

/**
 * Verify codex auth on the workspace. Returns true if `codex --version`
 * succeeds (presence of the binary is the cheap proxy; codex itself
 * doesn't expose a clean "am I authed?" subcommand at this version).
 */
export async function verifyCodexAuth(
  provider: CloudProvider,
  workspaceId: string,
): Promise<boolean> {
  const r = await provider.exec(workspaceId, 'bash -lc "codex --version"');
  return r.code === 0;
}
