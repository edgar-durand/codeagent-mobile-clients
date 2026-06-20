import pc from 'picocolors';
import qrcode from 'qrcode-terminal';
import pkg from '../../package.json';

const VERSION: string = pkg.version;

/**
 * UX banner helpers — all route to stderr (#67) so stdout stays
 * clean for piping. Concretely: `codeam sessions | jq`, `codeam
 * status | grep …`, and the smoke matrix that scrapes structured
 * output from stdout no longer get the cosmetic header lines mixed
 * in. Errors stay where shell convention expects them (`2>err.log`).
 *
 * Machine-readable output (help, version, doctor --json) lives in
 * the command modules and writes to stdout directly — not through
 * these helpers.
 */
function out(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function showIntro(): void {
  out('');
  out(`  ${pc.bold(pc.cyan('codeam'))}  ${pc.dim(`v${VERSION}`)}`);
  out('');
}

export function showSuccess(msg: string): void {
  out(`  ${pc.green('✓')} ${msg}`);
}

export function showError(msg: string): void {
  out(`  ${pc.red('✗')} ${msg}`);
}

export function showInfo(msg: string): void {
  out(`  ${pc.dim('·')} ${msg}`);
}

/**
 * Prominent notice printed once the agent is online over ACP. The ACP
 * adapter runs the agent headlessly — there is no interactive TUI in this
 * terminal, so typing here does nothing. QA repeatedly tried to type prompts
 * into the terminal and thought the integration was broken (#637). Make it
 * unmistakable that prompts come from the mobile app.
 */
export function showRelayNotice(): void {
  out('');
  out(`  ${pc.bold(pc.yellow('⚠  This terminal is a relay — do not type here.'))}`);
  out(`  ${pc.dim('Send your prompts from the CodeAgent Mobile app; replies stream in below.')}`);
  out('');
}

/**
 * Width of the box INTERIOR (between the two `│` columns). Must match
 * the number of `─` characters in the top and bottom borders below.
 * Changing one without the other misaligns every row — the previous
 * implementation hand-tuned per-row padding constants (19 / 15) that
 * didn't sum to this interior width, which is why the right `│` drifted
 * inward on screen.
 */
const BOX_INTERIOR = 30;
const BOX_BORDER_TOP = `  ┌${'─'.repeat(BOX_INTERIOR)}┐`;
const BOX_BORDER_BOT = `  └${'─'.repeat(BOX_INTERIOR)}┘`;

/**
 * Right-pad an interior box row so its visible length (i.e. after
 * stripping ANSI escapes) is exactly `BOX_INTERIOR`. Ensures the
 * trailing `│` column line up across every row regardless of the
 * styled content (which inflates `.length` with ANSI bytes).
 */
function boxRow(content: string, visibleLength: number): string {
  const pad = ' '.repeat(Math.max(0, BOX_INTERIOR - visibleLength));
  return `  │${content}${pad}│`;
}

/**
 * Show the pairing code in a static box. The countdown lives on the
 * waiting spinner (see `pair.ts`) — rendering it inside the box would
 * fight clack's spinner for cursor control and never reliably tick,
 * which is exactly what the previous "Expires in: 4:59" line did (it
 * printed once and never updated).
 */
export function showPairingCode(code: string): void {
  out(BOX_BORDER_TOP);
  // Visible prefix "  Code:  " = 9 chars; code is 6 chars; total 15
  // visible, padded out to BOX_INTERIOR. The ANSI bold+yellow wraps the
  // code AFTER we've computed the visible length so the pad is honest.
  const codeVisible = `  Code:  ${code}`.length;
  out(
    boxRow(`  Code:  ${pc.bold(pc.yellow(code))}`, codeVisible),
  );
  out(BOX_BORDER_BOT);
  out('');

  qrcode.generate(code, { small: true }, (qr: string) => {
    qr.split('\n').forEach((line) => out('  ' + line));
  });
  out('');
}

/** Format a remaining-seconds value as `M:SS`. */
export function formatRemaining(expiresAt: number): string {
  const secs = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}
