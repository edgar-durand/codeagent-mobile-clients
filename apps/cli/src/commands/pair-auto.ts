import * as fs from 'fs';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { isKnownAgentId } from '@codeagent/shared';
import { addSession } from '../config';
import { vercelBypassHeader } from '../lib/backend-headers';
import { detectCurrentBranch } from '../lib/git-branch';
import { start } from './start';

/**
 * `codeam pair-auto` — non-interactive pair, used INSIDE a freshly-
 * provisioned GitHub Codespace. The backend's `/api/deploys/codespace`
 * SSE handler has already minted a one-shot auto-pair token and
 * shipped it into the codespace via SSH env. The bootstrap script
 * writes the token to a 0600 temp file and invokes us with
 * `--token-file=<path>` (we never accept the token on argv to keep
 * it out of `ps -ef`).
 *
 * Once the redemption succeeds, this drops a SavedSession into the
 * config + chains into `start()` so the daemon polls commands the
 * same way `codeam pair` does.
 */

interface ClaimSuccess {
  sessionId: string;
  pluginAuthToken?: string;
  agent: string;
  user: { name: string; email: string; plan: string };
}

interface ClaimErrorBody {
  success: false;
  error: { code: string; message: string };
}

const API_BASE = process.env.CODEAM_API_URL ?? 'https://api.codeagent-mobile.com';

function fail(msg: string): never {
  // eslint-disable-next-line no-console
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

function readTokenFromArgs(args: string[]): string {
  const inline = args.find((a) => a.startsWith('--token='));
  if (inline) {
    const value = inline.slice('--token='.length).trim();
    if (value.length > 0) return value;
  }
  const fileFlag = args.find((a) => a.startsWith('--token-file='));
  if (fileFlag) {
    const path = fileFlag.slice('--token-file='.length);
    try {
      const content = fs.readFileSync(path, 'utf8').trim();
      if (content.length === 0) fail(`--token-file ${path} is empty`);
      // The bootstrap script created this file 0600. It deletes it on
      // shell EXIT, but we delete proactively too — the token is
      // single-use and we don't want it lingering on disk if `start()`
      // crashes before the EXIT trap fires.
      try { fs.unlinkSync(path); } catch { /* best-effort */ }
      return content;
    } catch (err) {
      fail(`Could not read --token-file: ${(err as Error).message}`);
    }
  }
  if (process.env.CODEAM_AUTO_TOKEN) return process.env.CODEAM_AUTO_TOKEN;
  fail('codeam pair-auto requires --token-file=<path>, --token=<value>, or CODEAM_AUTO_TOKEN env');
}

async function claim(token: string, pluginId: string): Promise<ClaimSuccess> {
  const url = `${API_BASE}/api/pairing/claim-auto-token`;
  const body = {
    token,
    pluginId,
    ideName: 'codeam-cli (codespace)',
    ideVersion: process.env.npm_package_version ?? 'unknown',
    hostname: os.hostname(),
    codespaceName: process.env.CODESPACE_NAME ?? '',
    // Current git branch of the codespace's working directory, so the
    // backend can populate `PairedSession.branch` for the codespace pair.
    // `null` when detached HEAD / not a git repo.
    branch: detectCurrentBranch(),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...vercelBypassHeader() },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as { success: boolean; data?: ClaimSuccess } | ClaimErrorBody;

  if (!res.ok || !('success' in json) || !json.success) {
    const errBody = json as ClaimErrorBody;
    const code = errBody?.error?.code ?? `HTTP_${res.status}`;
    const msg = errBody?.error?.message ?? `Server returned ${res.status}`;
    fail(`Auto-pair failed (${code}): ${msg}`);
  }

  const ok = json as { success: true; data: ClaimSuccess };
  if (!ok.data?.sessionId) {
    fail('Auto-pair response missing sessionId');
  }
  return ok.data;
}

export async function pairAuto(args: string[]): Promise<void> {
  const token = readTokenFromArgs(args);
  const pluginId = randomUUID();

  // eslint-disable-next-line no-console
  console.log('  Claiming pairing token…');
  const claimed = await claim(token, pluginId);

  // Validate the agent the API picked is one this CLI version knows about.
  // (Forward-compat guard for when the backend ships an agent we haven't released yet.)
  if (!isKnownAgentId(claimed.agent)) {
    fail(
      `agent "${claimed.agent}" is not supported in this codeam-cli version. ` +
      `Upgrade with 'npm i -g codeam-cli@latest'.`,
    );
  }

  addSession({
    id: claimed.sessionId,
    pluginId,
    userName: claimed.user.name,
    userEmail: claimed.user.email,
    plan: claimed.user.plan,
    pairedAt: Date.now(),
    pluginAuthToken: claimed.pluginAuthToken,
    agent: claimed.agent,
  });

  // eslint-disable-next-line no-console
  console.log(`  Paired with ${claimed.user.name} (${claimed.user.plan})`);
  // eslint-disable-next-line no-console
  console.log('  Starting agent loop…');

  // Hand off to the same long-running poller `codeam pair` ends with.
  await start();
}
