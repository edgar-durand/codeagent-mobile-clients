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
import { requestCode, pollStatus } from '../services/pairing.service';
import { addSession, loadCliConfig, saveCliConfig } from '../config';
import { start } from './start';
import { parseAgentFlag, promptForAgent } from '../utils/agent-prompt';

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

    stopPolling = pollStatus(
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
        showSuccess(`Paired with ${info.userName} (${info.plan})`);
        console.log('');
        resolve();
      },
      () => {
        clearInterval(countdownInterval);
        waitSpin.stop('Timed out');
        showError('Pairing timed out after 5 minutes. Run codeam pair to try again.');
        process.exit(1);
      },
    );

    process.once('SIGINT', sigintHandler);
  });

  await start();
}
