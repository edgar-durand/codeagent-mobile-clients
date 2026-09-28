import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/preview/index', () => ({
  killAllPreviews: vi.fn(),
}));
vi.mock('../../../src/scratch/export-tunnel', () => ({
  stopExportTunnel: vi.fn(),
}));

import { REAP_TIMEOUT_MS, reapPreviewsAndExportTunnel } from '../../../src/commands/start/shutdown-tunnels';
import { killAllPreviews } from '../../../src/services/preview/index';
import { stopExportTunnel } from '../../../src/scratch/export-tunnel';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reapPreviewsAndExportTunnel (the start.ts shutdown path)', () => {
  it('awaits both the previews AND the standalone export tunnel', async () => {
    let tunnelStopped = false;
    vi.mocked(killAllPreviews).mockResolvedValue(undefined);
    vi.mocked(stopExportTunnel).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      tunnelStopped = true;
    });

    await reapPreviewsAndExportTunnel();

    expect(killAllPreviews).toHaveBeenCalledTimes(1);
    expect(stopExportTunnel).toHaveBeenCalledTimes(1);
    expect(tunnelStopped).toBe(true);
  });

  it('a failing preview reap still stops the export tunnel, and never rejects', async () => {
    vi.mocked(killAllPreviews).mockRejectedValue(new Error('boom'));
    vi.mocked(stopExportTunnel).mockRejectedValue(new Error('boom2'));

    await expect(reapPreviewsAndExportTunnel()).resolves.toBeUndefined();
    expect(stopExportTunnel).toHaveBeenCalledTimes(1);
  });

  it('is BOUNDED: a hanging reap never hangs the exit, and a hanging preview reap still starts the tunnel stop', async () => {
    vi.mocked(killAllPreviews).mockImplementation(() => new Promise<void>(() => {}));
    vi.mocked(stopExportTunnel).mockImplementation(() => new Promise<void>(() => {}));

    const t0 = Date.now();
    await expect(reapPreviewsAndExportTunnel(50)).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(stopExportTunnel).toHaveBeenCalledTimes(1);
  }, 3_000);

  it('defaults to a 5 s bound', () => {
    expect(REAP_TIMEOUT_MS).toBe(5_000);
  });
});
