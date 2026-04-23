import pc from 'picocolors';
import qrcode from 'qrcode-terminal';
import pkg from '../../package.json';

const VERSION: string = pkg.version;

export function showIntro(): void {
  console.log('');
  console.log(`  ${pc.bold(pc.cyan('codeam'))}  ${pc.dim(`v${VERSION}`)}`);
  console.log('');
}

export function showSuccess(msg: string): void {
  console.log(`  ${pc.green('✓')} ${msg}`);
}

export function showError(msg: string): void {
  console.log(`  ${pc.red('✗')} ${msg}`);
}

export function showInfo(msg: string): void {
  console.log(`  ${pc.dim('·')} ${msg}`);
}

export function showPairingCode(code: string, expiresAt: number): void {
  const secs = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const timer = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  console.log('  ┌──────────────────────────────┐');
  const codePad = ' '.repeat(Math.max(0, 19 - code.length));
  const timerPad = ' '.repeat(Math.max(0, 15 - timer.length));
  console.log(`  │  Code:  ${pc.bold(pc.yellow(code))}${codePad}│`);
  console.log(`  │  Expires in: ${pc.dim(timer)}${timerPad}│`);
  console.log('  └──────────────────────────────┘');
  console.log('');

  qrcode.generate(code, { small: true }, (qr: string) => {
    qr.split('\n').forEach((line) => console.log('  ' + line));
  });
  console.log('');
}
