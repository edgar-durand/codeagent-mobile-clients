/**
 * `codeam link <agent>` — one-time CLI handoff that captures the
 * agent's local auth token and uploads it to the user's vault.
 *
 * Why this command exists:
 *
 *   1. Anthropic doesn't expose a public OAuth provider, so a web /
 *      mobile "Sign in with Anthropic" flow is impossible.
 *   2. The agent's local auth (`claude` REPL + `/login`, `codex
 *      login`) is the ONE place the user can prove they own that
 *      account. We capture the token it writes locally and seal it
 *      server-side so future surfaces (codespace deploy, `@codeagent`
 *      group mention, mobile-driven invocations) can reuse it
 *      without re-auth.
 *
 * Flow (max-automation, min-friction):
 *
 *   1. Pair the CLI to the mobile app the standard way — 6-digit
 *      code + QR; the user enters the code in mobile. Pair gives us
 *      a `pluginAuthToken` (HMAC over sessionId+pluginId) that auths
 *      the upload step.
 *   2. Ensure the agent CLI itself is installed. If missing we run
 *      the official installer non-interactively (no prompt).
 *   3. Probe known credential locations. If the user is already
 *      authenticated locally (Claude Pro/Max user with a prior
 *      `/login`, fresh `codex login`, …) we skip step 4 entirely.
 *   4. Otherwise: launch the agent's login flow + watch the
 *      credential paths with chokidar (file) + a 2 s poll loop
 *      (macOS Keychain). The watcher resolves as soon as the agent
 *      writes the token; we tear down the subprocess automatically.
 *   5. POST the captured blob to /api/plugin/agents/:agentId/link
 *      with the HMAC token in `X-Plugin-Auth-Token`. The backend
 *      seals it into the vault and emits `linked_agent_added` so the
 *      mobile UI flips to its success card.
 *   6. Print a one-line success summary and exit. The pair session
 *      survives — doubles as a regular command-relay channel so the
 *      user gets an immediate "you're online" affordance.
 *
 * Escape hatches the user can take when the auto-flow gets stuck:
 *   - `--api-key=<key>`        — paste an API key directly, skip
 *                                the local auth flow entirely.
 *   - `--reuse-existing`       — force the upload of whatever creds
 *                                the probe already finds (no relaunch
 *                                of the agent's login flow).
 *   - `--token-file=<path>`    — manual credential blob path; useful
 *                                when the agent stores its token
 *                                somewhere our probes don't know yet.
 */

import { type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chokidar from 'chokidar';
import pc from 'picocolors';
import { AGENT_REGISTRY, isKnownAgentId, type AgentId } from '@codeagent/shared';
import { p } from '../ui/prompts';
import {
  showIntro,
  showSuccess,
  showError,
  showInfo,
  showPairingCode,
  formatRemaining,
} from '../ui/banner';
import {
  requestCode,
  pollStatus,
  postLinkCredential,
  postLinkErrorSignal,
  type PairedUserInfo,
} from '../services/pairing.service';
import { addSession, getActiveSession, loadCliConfig, saveCliConfig } from '../config';
import { createRuntimeStrategy } from '../agents/registry';
import type {
  AgentCredentialLocator,
  AgentLoginLauncher,
  LocalAgentToken,
  RuntimeStrategy,
} from '../agents/strategy';

/**
 * Resolved per-agent link surface. Bundles the strategy itself + the
 * (locator, launcher) it produces so we don't call `runtime.credentialLocator()`
 * multiple times (the implementations are factory functions; calling
 * twice produces two distinct objects whose chokidar watchers
 * wouldn't share state).
 */
export interface LinkContext {
  runtime: RuntimeStrategy;
  locator: AgentCredentialLocator;
  launcher: AgentLoginLauncher;
  displayName: string;
  binary: string;
}

export function buildLinkContext(agentId: AgentId): LinkContext {
  const runtime = createRuntimeStrategy(agentId);
  return {
    runtime,
    locator: runtime.credentialLocator(),
    launcher: runtime.loginLauncher(),
    displayName: runtime.meta.displayName,
    binary: runtime.meta.binaryName,
  };
}

interface ParsedArgs {
  agent: AgentId;
  reuseExisting: boolean;
  apiKey: string | null;
  tokenFile: string | null;
  dryRun: boolean;
}

function enabledLinkableAgents(): AgentId[] {
  return Object.values(AGENT_REGISTRY)
    .filter((m) => m.enabled)
    .map((m) => m.id);
}

function parseLinkArgs(args: string[]): ParsedArgs {
  const positional = args.find((a) => !a.startsWith('--'));
  const valid = enabledLinkableAgents();
  if (!positional) {
    throw new Error(
      `Usage: codeam link <agent>\n         agent: ${valid.join(' | ')}`,
    );
  }
  // Backend-facing publicId aliases — `claude_code` (snake_case) is
  // the wire shape used by /api/plugin/agents/<publicId>/link, but
  // users typing `codeam link claude_code` should still work. Normalize
  // to the internal AgentId.
  const normalised = positional === 'claude_code' ? 'claude' : positional;
  if (!isKnownAgentId(normalised) || !AGENT_REGISTRY[normalised].enabled) {
    throw new Error(
      `Unknown or unsupported agent "${positional}". Valid: ${valid.join(', ')}`,
    );
  }
  const reuseExisting = args.includes('--reuse-existing');
  const dryRun = args.includes('--dry-run');
  // Two ways to supply an API key:
  //   --api-key=<key>       — convenient but visible to `ps -ef`
  //   --api-key-file=<path> — preferred for secrets in CI / scripts
  //                           (audit CLI finding 19 / quick win #67)
  // The file path takes precedence when both are passed.
  const apiKeyFileArg = args.find((a) => a.startsWith('--api-key-file='));
  let apiKey: string | null = null;
  if (apiKeyFileArg) {
    const filePath = apiKeyFileArg.slice('--api-key-file='.length);
    try {
      apiKey = fs.readFileSync(path.resolve(filePath), 'utf8').trim();
    } catch (err) {
      throw new Error(`Could not read --api-key-file ${filePath}: ${(err as Error).message}`);
    }
    if (!apiKey) {
      throw new Error(`--api-key-file ${filePath} is empty.`);
    }
  } else {
    const apiKeyArg = args.find((a) => a.startsWith('--api-key='));
    apiKey = apiKeyArg ? apiKeyArg.slice('--api-key='.length) : null;
  }
  const tokenFileArg = args.find((a) => a.startsWith('--token-file='));
  const tokenFile = tokenFileArg ? tokenFileArg.slice('--token-file='.length) : null;
  return { agent: normalised, reuseExisting, apiKey, tokenFile, dryRun };
}

export async function link(args: string[] = []): Promise<void> {
  const parsed = parseLinkArgs(args);
  const ctx = buildLinkContext(parsed.agent);

  showIntro();
  console.log(
    pc.bold(`  Link ${ctx.displayName}`) + pc.dim(`  ·  ${ctx.locator.vendor}`),
  );
  console.log('');

  // ─── 0. --dry-run: preflight the backend endpoint and exit ──────
  //
  // The CI smoke matrix uses this to validate that
  // /api/plugin/agents/<agentId>/link still exists and rejects
  // unauthenticated requests with 401. Catches the same protocol-drift
  // class of bug as `pair --dry-run` without spawning the agent's
  // login flow or needing a paired session.
  if (parsed.dryRun) {
    await linkDryRunPreflight(ctx);
    return;
  }

  // ─── 1. Pair ────────────────────────────────────────────────────
  const pluginId = randomUUID();
  const spin = p.spinner();
  spin.start('Requesting pairing code...');
  // If this `codeam link` was invoked from an already-paired session,
  // pass that session's HMAC triple so the backend can publish
  // `pairing_qr_ready` to the originating user's SSE bus the moment
  // the code lands. Mobile uses the event to flip the Scan-QR button
  // from disabled → enabled in the LinkAgent sheet (QA Android #8).
  // Bare `codeam link` with no prior pair on this machine sends none
  // of these fields and the backend silently no-ops the publish.
  const originator = getActiveSession();
  const pairing = await requestCode(pluginId, {
    originatorSessionId: originator?.id,
    originatorPluginId: originator?.pluginId,
    originatorAuthToken: originator?.pluginAuthToken,
  });
  if (!pairing) {
    spin.stop('Failed');
    showError('Could not reach the server. Check your connection and try again.');
    process.exit(1);
  }
  spin.stop('Got pairing code');
  showPairingCode(pairing.code);
  console.log(pc.dim('  Scan the QR or enter the code in CodeAgent Mobile.'));
  console.log('');

  const waitSpin = p.spinner();
  const waitMsg = (): string =>
    `Waiting for mobile pair... · expires in ${formatRemaining(pairing.expiresAt)}`;
  waitSpin.start(waitMsg());
  const countdown = setInterval(() => waitSpin.message(waitMsg()), 1000);
  countdown.unref?.();

  const paired = await new Promise<PairedUserInfo>((resolve, reject) => {
    let stopPoll: (() => void) | null = null;
    const sigint = (): void => {
      clearInterval(countdown);
      stopPoll?.();
      reject(new Error('cancelled'));
    };
    stopPoll = pollStatus(
      pluginId,
      (info) => {
        process.removeListener('SIGINT', sigint);
        clearInterval(countdown);
        waitSpin.stop('Paired');
        resolve(info);
      },
      () => {
        clearInterval(countdown);
        waitSpin.stop('Timed out');
        reject(new Error('Pairing timed out after 5 minutes. Run codeam link again.'));
      },
    );
    process.once('SIGINT', sigint);
  });

  if (!paired.pluginAuthToken) {
    showError(
      'Backend did not return a pluginAuthToken — upgrade api-v2 (deploy includes the link endpoint).',
    );
    process.exit(1);
  }

  // Persist the pair so the session shows up in `codeam sessions`
  // even if the rest of the link flow gets interrupted.
  addSession({
    id: paired.sessionId,
    pluginId,
    userName: paired.userName,
    userEmail: paired.userEmail,
    plan: paired.plan,
    pairedAt: Date.now(),
    pluginAuthToken: paired.pluginAuthToken,
    agent: ctx.runtime.id,
  });
  saveCliConfig({ ...loadCliConfig(), preferredAgent: ctx.runtime.id });

  // ─── 2. API-key escape hatch ────────────────────────────────────
  if (parsed.apiKey) {
    await uploadAndSucceed(ctx, paired, pluginId, {
      method: 'api_key',
      credential: parsed.apiKey.trim(),
      source: 'manual',
    });
    return;
  }

  // ─── 3. Manual token-file path ──────────────────────────────────
  if (parsed.tokenFile) {
    const credential = fs.readFileSync(path.resolve(parsed.tokenFile), 'utf8').trim();
    if (!credential) {
      showError(`--token-file ${parsed.tokenFile} is empty.`);
      process.exit(1);
    }
    await uploadAndSucceed(ctx, paired, pluginId, {
      method: 'oauth',
      credential,
      source: 'manual',
    });
    return;
  }

  // ─── 4. Ensure binary installed (no prompt) ─────────────────────
  const installSpin = p.spinner();
  installSpin.start(`Checking that ${ctx.binary} is installed...`);
  const installed = await ctx.launcher.ensureInstalled();
  if (!installed) {
    installSpin.stop('Failed');
    showError(`Could not install ${ctx.displayName}. Install it manually then re-run.`);
    process.exit(1);
  }
  installSpin.stop(`${ctx.displayName} is installed`);

  // ─── 5. Probe existing credentials ──────────────────────────────
  const existing = await ctx.locator.extract();
  if (existing) {
    if (await refuseIfStale(ctx, paired, pluginId, existing)) return;
    showInfo(`Found existing ${ctx.displayName} credentials at ${pc.bold(existing.source)}.`);
    await uploadAndSucceed(ctx, paired, pluginId, existing);
    return;
  }

  if (parsed.reuseExisting) {
    showError(
      `--reuse-existing set, but no local ${ctx.displayName} credentials were found at ${ctx.locator.hint}.`,
    );
    process.exit(1);
  }

  // ─── 6. Launch login + watch for fresh credentials ──────────────
  showInfo(
    `No local ${ctx.displayName} credentials found. Launching the sign-in — complete it in your browser, the CLI will detect the new token and finish automatically.`,
  );
  console.log('');

  const captured = await captureFreshCredentials(ctx);
  console.log('');
  if (await refuseIfStale(ctx, paired, pluginId, captured)) return;
  await uploadAndSucceed(ctx, paired, pluginId, captured);
}

/**
 * Run the locator's optional `validate()` on the captured token and
 * refuse the upload when it reports `expired`. Before bailing, POSTs
 * `linked_agent_link_failed` to the backend so the LinkAgent flow on
 * mobile / landing flips from its waiting spinner to an actionable
 * error card — otherwise the user would sit on the spinner forever
 * since the upload that would normally trigger the success SSE event
 * never happens.
 *
 * Returns `true` when the link command aborted (and has already
 * called `process.exit(1)`); `false` to continue with the upload.
 */
async function refuseIfStale(
  ctx: LinkContext,
  paired: PairedUserInfo,
  pluginId: string,
  token: LocalAgentToken,
): Promise<boolean> {
  const verdict = ctx.locator.validate?.(token);
  if (!verdict || verdict.status !== 'expired') return false;
  const reason = verdict.reason ?? 'Token expired';
  if (paired.pluginAuthToken) {
    await postLinkErrorSignal({
      agentId: ctx.locator.publicId,
      sessionId: paired.sessionId,
      pluginId,
      pluginAuthToken: paired.pluginAuthToken,
      code: 'credentials_expired',
      reason,
    });
  }
  showError(
    `Your local ${ctx.displayName} credentials at ${pc.bold(ctx.locator.hint)} are already expired:\n` +
      `   ${reason}\n\n` +
      `Uploading them would land a dead snapshot in the vault — every codespace bootstrapped from it would immediately return 401.\n\n` +
      `Run on your machine, then re-link:\n` +
      `   ${pc.cyan(`${ctx.binary} logout`)}\n` +
      `   ${pc.cyan(`${ctx.binary} login`)}\n` +
      `   ${pc.cyan(`codeam link ${ctx.locator.publicId}`)}`,
  );
  process.exit(1);
}

/**
 * Spawn the agent's interactive auth flow + watch all known
 * credential locations. Resolves as soon as the watcher reads a
 * non-empty token at any path (or finds the keychain entry on macOS).
 *
 * Cleans up the subprocess + watcher in both success and failure.
 */
async function captureFreshCredentials(ctx: LinkContext): Promise<LocalAgentToken> {
  const isWin = ctx.runtime.os.id === 'win32';
  const watcher = chokidar.watch(ctx.locator.watchPaths(), {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    // Windows-only: when a credential file's ancestor is missing,
    // chokidar walks up to the closest existing parent and starts
    // traversing it. On a default Windows shell that ancestor is
    // `C:\Users\<u>`, which contains legacy junctions whose ACL makes
    // `fs.watch` throw EPERM (#43). These flags are no-ops on macOS,
    // where the user has read access to their entire home.
    ...(isWin ? { followSymlinks: false, ignorePermissionErrors: true } : {}),
  });

  // chokidar bubbles fs errors as `error` events through Node's
  // EventEmitter — without a listener, an unhandled error crashes the
  // process. Swallow it: the link flow can keep waiting on the other
  // paths / the keychain re-probe loop and will surface a clean
  // timeout if nothing ever arrives.
  watcher.on('error', () => { /* logged elsewhere via the watcher's own error events; swallow here */ });

  let child: ChildProcess | null = null;
  let keychainPoll: NodeJS.Timeout | null = null;

  const cleanup = (): void => {
    void watcher.close();
    if (keychainPoll) clearInterval(keychainPoll);
    if (child && !child.killed) {
      // SIGTERM first; the agent's REPL traps it and exits clean.
      // If it ignores, the user can Ctrl+C out — the process group
      // exit is enough either way.
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
  };

  try {
    const token = await new Promise<LocalAgentToken>((resolve, reject) => {
      let settled = false;
      const tryExtract = async (): Promise<void> => {
        if (settled) return;
        const t = await ctx.locator.extract();
        if (t && !settled) {
          settled = true;
          resolve(t);
        }
      };

      watcher.on('add', () => void tryExtract());
      watcher.on('change', () => void tryExtract());
      // Polling cadence for the macOS Keychain. chokidar can't watch
      // the keychain, so we re-probe every 2 s. Cheap — one `security`
      // exec per tick, gated on settled.
      keychainPoll = setInterval(() => void tryExtract(), 2000);
      keychainPoll.unref?.();

      const sigint = (): void => {
        if (settled) return;
        settled = true;
        reject(new Error('cancelled'));
      };
      process.once('SIGINT', sigint);

      // 5-minute hard timeout. If the user wandered off and never
      // finished the OAuth, surface a clear timeout rather than
      // hanging the terminal indefinitely.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Timed out waiting for ${ctx.displayName} sign-in (5 minutes).`));
      }, 5 * 60_000);

      // Spawn the agent login flow last so any synchronous output
      // from the agent is bracketed by our watcher.
      child = ctx.launcher.launch();
      child.on('exit', () => {
        // Give the disk one last chance — the agent may have written
        // the token just before exiting. If still nothing after the
        // grace, surface a friendlier error than "child exited".
        void tryExtract().then(() => {
          if (!settled) {
            settled = true;
            reject(
              new Error(
                `${ctx.binary} exited but no credentials were written at ${ctx.locator.hint}.`,
              ),
            );
          }
        });
      });
    });
    cleanup();
    return token;
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * POST the captured credential to the backend's link endpoint + print
 * a success summary. Pulled out of the main flow so api_key /
 * token-file / file-watcher all funnel through the same upload code.
 */
async function uploadAndSucceed(
  ctx: LinkContext,
  paired: PairedUserInfo,
  pluginId: string,
  token: LocalAgentToken,
): Promise<void> {
  if (!paired.pluginAuthToken) {
    // Belt-and-braces — should have been caught earlier.
    showError('Missing pluginAuthToken; re-run codeam link.');
    process.exit(1);
  }
  const uploadSpin = p.spinner();
  uploadSpin.start('Sealing credential in your vault...');
  const result = await postLinkCredential({
    agentId: ctx.locator.publicId,
    sessionId: paired.sessionId,
    pluginId,
    pluginAuthToken: paired.pluginAuthToken,
    method: token.method,
    credential: token.credential,
    agentState: token.agentState,
  });
  if (!result.ok) {
    uploadSpin.stop('Failed');
    if (result.status === 401) {
      showError('Pair token rejected by the backend (401). Re-run `codeam link`.');
    } else if (result.status === 404) {
      showError(
        `${ctx.displayName} link endpoint not available on this backend (404). ` +
          'The api-v2 deployment may not yet include the route.',
      );
    } else {
      showError(`Upload failed: ${result.message}`);
    }
    process.exit(1);
  }
  uploadSpin.stop('Linked');

  console.log('');
  showSuccess(`${ctx.displayName} is now linked to ${paired.userEmail || paired.userName}.`);
  showInfo(
    `Your codespaces and @codeagent mentions can now use ${ctx.displayName} without you signing in again.`,
  );
  console.log('');
}

/**
 * `--dry-run` preflight for the CI smoke matrix.
 *
 * Submits a deliberately-unauthenticated request to the link endpoint
 * and expects the backend to reject it with HTTP 401. A 401 proves:
 *   - DNS / TLS / CDN routing to api.codeagent-mobile.com works
 *   - The /api/plugin/agents/<agentId>/link route still exists in the
 *     deployed backend
 *   - The PluginAuthGuard is wired up and rejecting bad tokens
 *
 * Anything else (404 → endpoint moved/removed; 5xx → backend down;
 * network error → connectivity broken) is surfaced as an exit-1.
 *
 * No real credential is sent; the body uses stub strings so a server
 * mis-configured to NOT auth-check would still fail downstream
 * validation rather than create a database record.
 */
async function linkDryRunPreflight(ctx: LinkContext): Promise<void> {
  const publicId = ctx.locator.publicId;
  const spin = p.spinner();
  spin.start(`Probing ${publicId} link endpoint...`);
  const result = await postLinkCredential({
    agentId: publicId,
    sessionId: 'dryrun-session',
    pluginId: 'dryrun-plugin',
    pluginAuthToken: 'dryrun-token',
    method: 'oauth',
    credential: 'dryrun-credential',
  });
  if (result.ok) {
    spin.stop('Unexpected 2xx');
    showError(
      'Link dry-run: backend accepted a stub credential (2xx). PluginAuthGuard appears to be disabled — investigate api-v2.',
    );
    process.exit(1);
  }
  if (result.status === 401) {
    spin.stop('Endpoint OK');
    showSuccess(
      `Link dry-run OK — /api/plugin/agents/${publicId}/link reachable and auth-gated (401 as expected).`,
    );
    process.exit(0);
  }
  spin.stop('Failed');
  showError(
    `Link dry-run: unexpected response from /api/plugin/agents/${publicId}/link (status=${result.status}, message=${result.message}). Expected 401.`,
  );
  process.exit(1);
}
