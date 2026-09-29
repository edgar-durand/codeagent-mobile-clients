import { beforeEach, describe, expect, it, vi } from 'vitest';

const postScratchOffer = vi.fn();
const isScratchWorkspace = vi.fn();
vi.mock('../../src/scratch/api', () => ({
  postScratchOffer: (...a: unknown[]) => postScratchOffer(...a),
  registerScratchProject: vi.fn(),
  postZipDownloaded: vi.fn(),
}));
vi.mock('../../src/scratch/workspace', () => ({
  isScratchWorkspace: (...a: unknown[]) => isScratchWorkspace(...a),
  SCRATCH_MARKER: 'codeam-scratch',
}));

import { offerScratchSaveOnce, resetScratchOfferForTests } from '../../src/commands/start/handlers';

const ctx = { sessionId: 's1', pluginId: 'p1' };

describe('preview_ready → scratch save offer (post-tool hook)', () => {
  beforeEach(() => {
    resetScratchOfferForTests();
    postScratchOffer.mockReset();
    isScratchWorkspace.mockReset();
  });

  it('offers once per session in a scratch workspace, with the session identity', async () => {
    isScratchWorkspace.mockReturnValue(true);
    postScratchOffer.mockResolvedValue(true);
    await offerScratchSaveOnce(ctx, 'tok');
    await offerScratchSaveOnce(ctx, 'tok');
    expect(postScratchOffer).toHaveBeenCalledTimes(1);
    expect(postScratchOffer).toHaveBeenCalledWith({
      sessionId: 's1',
      pluginId: 'p1',
      pluginAuthToken: 'tok',
    });
  });

  it('never fires outside a scratch workspace', async () => {
    isScratchWorkspace.mockReturnValue(false);
    await offerScratchSaveOnce(ctx, 'tok');
    expect(postScratchOffer).not.toHaveBeenCalled();
  });

  it('a refused offer is retried on the next ready', async () => {
    isScratchWorkspace.mockReturnValue(true);
    postScratchOffer.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await offerScratchSaveOnce(ctx, 'tok');
    await offerScratchSaveOnce(ctx, 'tok');
    await offerScratchSaveOnce(ctx, 'tok');
    expect(postScratchOffer).toHaveBeenCalledTimes(2);
  });
});
