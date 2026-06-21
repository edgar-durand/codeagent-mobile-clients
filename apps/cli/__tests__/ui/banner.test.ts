import { describe, it, expect, vi, afterEach } from 'vitest';

// Stub the QR generator so the test is deterministic + doesn't depend on the
// real qrcode-terminal output. It invokes the callback synchronously with two
// recognisable lines.
vi.mock('qrcode-terminal', () => ({
  default: {
    generate: vi.fn((_code: string, _opts: unknown, cb: (qr: string) => void) => {
      cb('QR-LINE-1\nQR-LINE-2');
    }),
  },
}));

import { showPairingCode } from '../../src/ui/banner';

describe('showPairingCode (#356 regression)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the pairing code box + QR to stderr, never stdout', () => {
    // The bug: the code/QR were on stdout — the same stream as the clack
    // waiting-spinner that follows — so the spinner's cursor redraw clobbered
    // them (and a piped/non-TTY stdout dropped them entirely), leaving "pair
    // keeps loading, no QR". Everything must be on stderr like the rest of the
    // banner UI.
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    showPairingCode('ABC123');

    // Nothing leaks onto stdout (also keeps the short-lived pairing secret out
    // of a piped stdout).
    expect(stdoutSpy).not.toHaveBeenCalled();

    const rendered = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
    // The code is rendered letter-spaced for low-vision legibility.
    expect(rendered).toContain('A B C 1 2 3');
    // …and the QR lines land on stderr too.
    expect(rendered).toContain('QR-LINE-1');
    expect(rendered).toContain('QR-LINE-2');
  });
});
