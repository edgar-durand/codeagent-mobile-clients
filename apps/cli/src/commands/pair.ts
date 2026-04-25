import { randomUUID } from 'crypto';
import pc from 'picocolors';
import { p } from '../ui/prompts';
import { showIntro, showSuccess, showError, showPairingCode } from '../ui/banner';
import { requestCode, pollStatus } from '../services/pairing.service';
import { addSession } from '../config';
import { start } from './start';

export async function pair(): Promise<void> {
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
  showPairingCode(result.code, result.expiresAt);
  console.log(pc.dim('  Scan the QR code or enter the code in CodeAgent Mobile.'));
  console.log('');

  const waitSpin = p.spinner();
  waitSpin.start('Waiting for mobile app...');

  await new Promise<void>((resolve) => {
    let stopPolling: (() => void) | null = null;

    function sigintHandler() {
      stopPolling?.();
      console.log('');
      process.exit(0);
    }

    stopPolling = pollStatus(
      pluginId,
      (info) => {
        process.removeListener('SIGINT', sigintHandler);
        waitSpin.stop('Paired!');
        addSession({
          id: info.sessionId,
          pluginId,
          userName: info.userName,
          userEmail: info.userEmail,
          plan: info.plan,
          pairedAt: Date.now(),
          pluginAuthToken: info.pluginAuthToken,
        });
        showSuccess(`Paired with ${info.userName} (${info.plan})`);
        console.log('');
        resolve();
      },
      () => {
        waitSpin.stop('Timed out');
        showError('Pairing timed out after 5 minutes. Run codeam pair to try again.');
        process.exit(1);
      },
    );

    process.once('SIGINT', sigintHandler);
  });

  await start();
}
