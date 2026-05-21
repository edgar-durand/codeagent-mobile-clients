/**
 * `codeam link <agent>` — one-time CLI handoff that captures the
 * agent's local auth token and uploads it to the user's vault.
 *
 * Why this command exists:
 *
 *   1. Anthropic doesn't expose a public OAuth provider, so a web /
 *      mobile "Sign in with Anthropic" flow is impossible.
 *   2. The agent's local auth (`claude login`, `codex login`) is the
 *      ONE place the user can prove they own that account. We capture
 *      the token it writes locally and seal it server-side so future
 *      surfaces (codespace deploy, `@codeagent` group mention,
 *      mobile-driven invocations) can reuse it without re-auth.
 *
 * Flow:
 *
 *   1. Pair the CLI to the mobile app the standard way — 6-digit code
 *      + QR; the user enters the code in mobile. Pair gives us a
 *      pluginAuthToken (HMAC over sessionId+pluginId) that auths the
 *      upload step.
 *   2. If the agent already has a local token (left over from a prior
 *      `<agent> login`), reuse it. Otherwise spawn `<agent> login` as
 *      a foreground subprocess so the user completes the OAuth in
 *      their own browser. Wait for the binary to exit, then re-read.
 *   3. POST the captured blob to /api/plugin/agents/:agentId/link
 *      with the pluginAuthToken. Backend seals it into the vault and
 *      emits `linked_agent_added` so mobile flips to its success card.
 *   4. Print a one-line success summary and exit. The pair session
 *      survives — it doubles as a regular command-relay channel so
 *      the user gets an immediate "you're online" affordance.
 *
 * Failure modes are intentional dead-ends with actionable messages:
 *   - Agent binary missing → "install <agent>-cli first" + link
 *   - Login subprocess non-zero exit → "didn't see a token, try again"
 *   - 401 from /link → pair must have expired; re-run `codeam link`
 *   - 404 NOT_AVAILABLE → backend hasn't enabled the agent yet
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pc from 'picocolors';
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
  type PairedUserInfo,
} from '../services/pairing.service';
import { addSession, loadCliConfig, saveCliConfig } from '../config';
import {
  extractLocalClaudeToken,
  claudeCredentialsMtime,
} from '../agents/claude/local-token';
import {
  extractLocalCodexToken,
  codexCredentialsMtime,
} from '../agents/codex/local-token';
import type { LocalAgentToken } from '../agents/claude/local-token';

type LinkAgent = 'claude' | 'codex';

interface LinkAgentMeta {
  /** Internal CLI id — matches `AgentId` from `@codeagent/shared`. */
  internalId: LinkAgent;
  /** Public id the backend's `/api/plugin/agents/:agentId/link` route
   *  accepts. Same mapping as `apps/api-v2/src/linked-agents/agent-map.ts`. */
  publicId: 'claude_code' | 'codex';
  /** Binary name on PATH used to launch the interactive login flow. */
  binary: 'claude' | 'codex';
  /** Subcommand for the auth flow (`claude login`, `codex login`). */
  loginArgs: string[];
  displayName: string;
  vendor: string;
  /** Filesystem hint shown in error messages. */
  credentialsHint: string;
  extract: () => Promise<LocalAgentToken | null>;
  mtime: () => number | null;
}

const AGENT_META: Record<LinkAgent, LinkAgentMeta> = {
  claude: {
    internalId: 'claude',
    publicId: 'claude_code',
    binary: 'claude',
    loginArgs: ['login'],
    displayName: 'Claude Code',
    vendor: 'Anthropic',
    credentialsHint: '~/.claude/.credentials.json (or macOS Keychain)',
    extract: extractLocalClaudeToken,
    mtime: claudeCredentialsMtime,
  },
  codex: {
    internalId: 'codex',
    publicId: 'codex',
    binary: 'codex',
    loginArgs: ['login'],
    displayName: 'Codex',
    vendor: 'OpenAI',
    credentialsHint: '~/.codex/auth.json',
    extract: extractLocalCodexToken,
    mtime: codexCredentialsMtime,
  },
};

function parseLinkArgs(args: string[]): {
  agent: LinkAgent;
  reuseExisting: boolean;
} {
  // First positional arg is the agent kind. Accept the public id too
  // ("claude_code") so the mobile copy-paste command works verbatim.
  const positional = args.find((a) => !a.startsWith('--'));
  if (!positional) {
    throw new Error(
      `Usage: codeam link <agent>\n         agent: ${Object.keys(AGENT_META).join(' | ')}`,
    );
  }
  const normalised = positional === 'claude_code' ? 'claude' : positional;
  if (normalised !== 'claude' && normalised !== 'codex') {
    throw new Error(
      `Unknown agent "${positional}". Valid: ${Object.keys(AGENT_META).join(', ')}`,
    );
  }
  const reuseExisting = args.includes('--reuse-existing');
  return { agent: normalised, reuseExisting };
}

export async function link(args: string[] = []): Promise<void> {
  const { agent, reuseExisting } = parseLinkArgs(args);
  const meta = AGENT_META[agent];

  showIntro();
  console.log(
    pc.bold(`  Link ${meta.displayName}`) + pc.dim(`  ·  ${meta.vendor}`),
  );
  console.log('');

  // 1. Pair — exact same shape as `codeam pair`. We need a paired
  //    session for the HMAC auth on the upload step.
  const pluginId = randomUUID();
  const spin = p.spinner();
  spin.start('Requesting pairing code...');
  const pairing = await requestCode(pluginId);
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
  // immediately + the dashboard's "WORKSTATION" pill picks it up.
  // We do this BEFORE the link upload so a partial run still leaves
  // the user with a usable pair.
  addSession({
    id: paired.sessionId,
    pluginId,
    userName: paired.userName,
    userEmail: paired.userEmail,
    plan: paired.plan,
    pairedAt: Date.now(),
    pluginAuthToken: paired.pluginAuthToken,
    agent: meta.internalId,
  });
  saveCliConfig({ ...loadCliConfig(), preferredAgent: meta.internalId });

  // 2. Token extraction — try local first; fall back to running the
  //    agent's own login flow interactively.
  let token = await meta.extract();
  if (token && reuseExisting) {
    showInfo(`Reusing existing ${meta.displayName} token at ${pc.bold(meta.credentialsHint)}.`);
  } else {
    const beforeMtime = meta.mtime();
    showInfo(`Launching ${pc.bold(`${meta.binary} ${meta.loginArgs.join(' ')}`)} — complete the sign-in in your browser, then return here.`);
    console.log('');
    const code = await runAgentLogin(meta);
    console.log('');
    if (code !== 0) {
      showError(
        `${meta.binary} ${meta.loginArgs.join(' ')} exited with code ${code}. ` +
          'Re-run when ready.',
      );
      process.exit(1);
    }
    // Re-read AFTER login. The interactive flow may have written a
    // fresh blob to the same path.
    const refreshed = await meta.extract();
    const afterMtime = meta.mtime();
    if (!refreshed) {
      showError(
        `${meta.displayName} login finished but no credential was found at ${meta.credentialsHint}. ` +
          'Re-run when ready.',
      );
      process.exit(1);
    }
    // Defensive: if mtime didn't move AND the content matches the
    // pre-login token, the user likely cancelled the flow mid-way.
    // Surface this rather than uploading stale bytes.
    if (
      token &&
      refreshed.credential === token.credential &&
      beforeMtime !== null &&
      afterMtime !== null &&
      afterMtime <= beforeMtime
    ) {
      showError(
        `${meta.displayName} login didn't produce a fresh token. Re-run when ready, or pass --reuse-existing to keep the current one.`,
      );
      process.exit(1);
    }
    token = refreshed;
  }

  // 3. Upload — POSTs to /api/plugin/agents/:publicId/link with the
  //    HMAC token in `X-Plugin-Auth-Token`. The backend seals + emits
  //    `linked_agent_added`.
  const uploadSpin = p.spinner();
  uploadSpin.start('Sealing credential in your vault...');
  const result = await postLinkCredential({
    agentId: meta.publicId,
    sessionId: paired.sessionId,
    pluginId,
    pluginAuthToken: paired.pluginAuthToken,
    method: token.method,
    credential: token.credential,
  });
  if (!result.ok) {
    uploadSpin.stop('Failed');
    if (result.status === 401) {
      showError(
        'Pair token rejected by the backend (401). Re-run `codeam link` to start fresh.',
      );
    } else if (result.status === 404) {
      showError(
        `${meta.displayName} link endpoint not available on this backend (404). ` +
          'The api-v2 deployment may not yet include the /api/plugin/agents/:agentId/link route.',
      );
    } else {
      showError(`Upload failed: ${result.message}`);
    }
    process.exit(1);
  }
  uploadSpin.stop('Linked');

  console.log('');
  showSuccess(`${meta.displayName} is now linked to ${paired.userEmail || paired.userName}.`);
  showInfo(
    `Your codespaces and @codeagent mentions can now use ${meta.displayName} without you signing in again.`,
  );
  console.log('');
}

/**
 * Spawn `<binary> login` as a foreground subprocess. `stdio: 'inherit'`
 * so the user sees the binary's own prompts directly — no buffering,
 * no relay, no spinner fighting for cursor control. Resolves with the
 * exit code; non-zero is reported up.
 *
 * If the binary is missing we surface a friendly error pointing at the
 * agent's install instructions rather than letting Node's ENOENT
 * bubble up as a stack trace.
 */
function runAgentLogin(meta: LinkAgentMeta): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(meta.binary, meta.loginArgs, { stdio: 'inherit' });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        showError(
          `${meta.binary} binary not found on PATH. Install ${meta.displayName} first, then re-run \`codeam link ${meta.internalId}\`.`,
        );
        resolve(127);
        return;
      }
      showError(`Failed to launch ${meta.binary}: ${err.message}`);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}
