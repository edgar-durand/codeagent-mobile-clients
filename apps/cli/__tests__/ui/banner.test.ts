import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('qrcode-terminal', () => ({
  default: {
    generate: vi.fn((_code: string, _opts: unknown, cb: (qr: string) => void) => {
      cb('QR-LINE-1\nQR-LINE-2');
    }),
  },
}));

import { showPairingCode } from '../../src/ui/banner';

describe('banner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the pairing code and QR to stderr, not stdout', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    showPairingCode('ABC123');

    expect(stdoutSpy).not.toHaveBeenCalled();
    const rendered = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(rendered).toContain('ABC123');
    expect(rendered).toContain('QR-LINE-1');
    expect(rendered).toContain('QR-LINE-2');
  });
});
