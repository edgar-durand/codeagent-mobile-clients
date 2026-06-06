import { randomUUID } from 'crypto';
import pc from 'picocolors';
import { p } from '../ui/prompts';
import {
  showIntro,
  showSuccess,
  showError,
  showPairingCode,
  formatRemaining,
} from '../ui/banner';
import { requestCode, postLinkCredential } from '../services/pairing.service';
import { subscribeToPairCompletion } from '../services/pair-completion-subscriber';
import { addSession, loadCliConfig, saveCliConfig } from '../config';
import { start } from './start';
import { parseAgentFlag, promptForAgent } from '../utils/agent-prompt';
import { capture, identifyUser } from '../services/telemetry.service';
import { createAgentStrategy } from '../agents/registry';

export async function pair(args: string[] = []): Promise<void> {
  const config = loadCliConfig();
  const dryRun = args.includes('--dry-run');
  const flagAgent = parseAgentFlag(args);
  const agentId = dryRun
    ? (flagAgent ?? config.preferredAgent ?? 'claude')
    : (flagAgent ?? (await promptForAgent(config.preferredAgent ?? 'claude')));

  showIntro();

  // Generate a fresh pluginId for this pairing so multiple sessions from the
  // same machine can coexist without overwriting each other.
  const pluginId = randomUUID();
  capture('pair_started', { agentId, pluginId, dryRun });
  const spin = p.spinner();
  spin.start('Requesting pairing code...');

  const result = await requestCode(pluginId);
  if (!result) {
    spin.stop('Failed');
    showError('Could not reach the server. Check your connection and try again.');
    process.exit(1);
  }

  spin.stop('Got pairing code');

  // --dry-run: validate the backend response shape and exit. Used by
  // the CI smoke matrix to catch protocol drift on /api/pairing/code
  // without needing a real mobile device to complete the pairing.
  if (dryRun) {
    // Lenient shape check on purpose: the dry-run is meant to catch
    // "endpoint moved / returned 5xx / response totally reshaped" —
    // not minor encoding choices like base32 codes vs digits, or
    // expires-in-seconds vs ms. We only require that both fields are
    // present with the documented types and non-empty / positive.
    const codeOk = typeof result.code === 'string' && result.code.trim().length > 0;
    const expiresOk = typeof result.expiresAt === 'number' && result.expiresAt > 0;
    if (!codeOk || !expiresOk) {
      // Don't echo `result.code` — even on failure it's a short-lived
      // bearer secret for pairing.
      showError(
        `Pair dry-run: backend response shape unexpected (codeType=${typeof result.code}, codeEmpty=${!codeOk}, expiresType=${typeof result.expiresAt}, expiresPositive=${expiresOk}).`,
      );
      process.exit(1);
    }
    showSuccess(
      `Pair dry-run OK — backend reachable, response shape valid (codeLength=${result.code.length}, expiresAt=${result.expiresAt}, agent=${agentId}).`,
    );
    process.exit(0);
  }

  showPairingCode(result.code);
  console.log(pc.dim('  Scan the QR code or enter the code in CodeAgent Mobile.'));
  console.log('');

  const waitSpin = p.spinner();
  const waitMessage = (): string =>
    `Waiting for mobile app... · expires in ${formatRemaining(result.expiresAt)}`;
  waitSpin.start(waitMessage());

  // Countdown lives on the spinner message — `clack/prompts` ticks
  // the spinner frame on its own animation loop, so calling
  // `.message(...)` once per second updates the visible "expires in
  // M:SS" segment without us having to mess with ANSI cursor moves
  // (which would fight clack for the same line). When the spinner
  // stops we clear the interval to avoid leaking a timer that
  // would write to a stopped spinner.
  const countdownInterval = setInterval(() => {
    waitSpin.message(waitMessage());
  }, 1000);
  // Make sure the interval doesn't pin the event loop when the
  // process tries to exit (e.g. on SIGINT).
  countdownInterval.unref?.();

  await new Promise<void>((resolve) => {
    let stopPolling: (() => void) | null = null;

    function sigintHandler() {
      clearInterval(countdownInterval);
      stopPolling?.();
      console.log('');
      process.exit(0);
    }

    stopPolling = subscribeToPairCompletion(
      pluginId,
      (info) => {
        process.removeListener('SIGINT', sigintHandler);
        clearInterval(countdownInterval);
        waitSpin.stop('Paired!');
        addSession({
          id: info.sessionId,
          pluginId,
          userName: info.userName,
          userEmail: info.userEmail,
          plan: info.plan,
          pairedAt: Date.now(),
          pluginAuthToken: info.pluginAuthToken,
          agent: agentId,
        });
        // Persist preferredAgent for next time (reload to pick up activeSessionId written by addSession)
        saveCliConfig({ ...loadCliConfig(), preferredAgent: agentId });

        // Telemetry: identify the user + attach session context to
        // every subsequent capture. Falls back to email when the
        // backend response omits user.id (older backends).
        identifyUser({
          userId: info.userId ?? info.userEmail,
          email: info.userEmail,
          name: info.userName,
          plan: info.plan,
          preferredAgent: agentId,
          pairedSessionCount: loadCliConfig().sessions.length,
        });
        capture('pair_succeeded', {
          sessionId: info.sessionId,
          pluginId,
          agentId,
        });

        showSuccess(`Paired with ${info.userName} (${info.plan})`);
        console.log('');

        // Best-effort auto-link: extract the chosen agent's local
        // credentials + identity state and seal them into the user's
        // vault in the same step. Removes the need for a separate
        // `codeam link <agent>` command — pair just works.
        //
        // Silent on every failure (no local install, no Keychain
        // entry, network blip, older backend without the route).
        // Pair stays green and the user can run `codeam link
        // <agent>` later if they want to retry.
        if (info.pluginAuthToken) {
          void autoLinkAfterPair({
            agentId,
            sessionId: info.sessionId,
            pluginId,
            pluginAuthToken: info.pluginAuthToken,
          });
        }

        resolve();
      },
      () => {
        clearInterval(countdownInterval);
        waitSpin.stop('Timed out');
        capture('pair_timed_out', { agentId, pluginId });
        showError('Pairing timed out after 5 minutes. Run codeam pair to try again.');
        process.exit(1);
      },
    );

    process.once('SIGINT', sigintHandler);
  });

  await start();
}

/**
 * Capture the local credentials for the just-paired agent and seal
 * them into the user's vault. Sibling of `codeam link <agent>` but
 * inlined into the pair flow so the user never has to think about
 * a second command. Everything here is best-effort:
 *
 *   - No locally-installed agent / no credentials file / no Keychain
 *     entry → `extract()` returns null, we no-op.
 *   - Older backend without the route → 404 from postLinkCredential,
 *     we no-op.
 *   - Network blip → catch + no-op.
 *
 * Pair must not fail because the user hasn't logged into the agent
 * yet (they can still pair + drive the agent from mobile without a
 * vaulted credential — the LinkedAgent is only required for
 * codespace Auto-login and `@codeagent` mentions).
 *
 * `preserveSession: true` tells the backend to keep the
 * PairedSession that pair just created — the standalone `codeam
 * link <agent>` flow deletes a throwaway session here, which would
 * kick the user off the device they just paired.
 */
async function autoLinkAfterPair(opts: {
  agentId: ReturnType<typeof parseAgentFlag>;
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
}): Promise<void> {
  if (!opts.agentId) return;
  try {
    const strategy = createAgentStrategy(opts.agentId);
    const locator = strategy.credentialLocator();
    const token = await locator.extract();
    if (!token) {
      capture('pair_auto_link_skipped', { agentId: opts.agentId, reason: 'no_local_creds' });
      return;
    }
    const res = await postLinkCredential({
      agentId: locator.publicId,
      sessionId: opts.sessionId,
      pluginId: opts.pluginId,
      pluginAuthToken: opts.pluginAuthToken,
      method: token.method,
      credential: token.credential,
      agentState: token.agentState,
      preserveSession: true,
    });
    if (res.ok) {
      capture('pair_auto_link_succeeded', {
        agentId: opts.agentId,
        source: token.source,
        hasState: Boolean(token.agentState),
      });
    } else {
      capture('pair_auto_link_failed', { agentId: opts.agentId, status: res.status });
    }
  } catch (err) {
    capture('pair_auto_link_threw', {
      agentId: opts.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
