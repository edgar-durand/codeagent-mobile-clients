/**
 * Wiring test for `maybeAttachBuildHeal` (commands/start/handlers.ts) — the
 * glue that arms `watchForBuildClobber` (services/preview/build-heal.ts) on
 * a live preview and, on a detected clobber, drives the restart through the
 * EXACT SAME path `preview_restart` uses: `previewSvc.killPreview` then
 * `startPreviewFromDetection` from the stored detection.
 *
 * This exercises a REAL fs.watch against a REAL temp `.next/BUILD_ID` file
 * — the full sequence from the bug report: preview `running` → a build
 * rewrites the marker → the dev server gets killed and re-spawned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import type { ChildProcess } from 'child_process';

const { mockPostPreviewEvent } = vi.hoisted(() => ({
  mockPostPreviewEvent: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../src/services/pairing.service', () => ({
  postLinkCredential: vi.fn().mockResolvedValue(undefined),
  postAiResult: vi.fn().mockResolvedValue(undefined),
  postPreviewEvent: mockPostPreviewEvent,
  postHeadroomEvent: vi.fn().mockResolvedValue(undefined),
  postBeadsEvent: vi.fn().mockResolvedValue(undefined),
  postCliUpdateEvent: vi.fn().mockResolvedValue(undefined),
  postCoderabbitEvent: vi.fn().mockResolvedValue(undefined),
  postAgentReviewReport: vi.fn().mockResolvedValue(undefined),
  fetchProvisionCredential: vi.fn().mockResolvedValue(undefined),
}));

import * as handlersMod from '../../src/commands/start/handlers';
import * as previewSvc from '../../src/services/preview';
import { activePreviews, registerPreview, resetBuildHealState } from '../../src/services/preview';
import type { PreviewDetection } from '@codeam/shared';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeProcess(): ChildProcess {
  return { exitCode: null, kill: vi.fn() } as unknown as ChildProcess;
}

function makeCtx() {
  return {
    sessionId: 'sess-heal-1',
    pluginId: 'plug-1',
    pluginAuthToken: 'tok',
    relay: { sendResult: vi.fn() },
  } as any;
}

describe('maybeAttachBuildHeal wiring', () => {
  let dir: string;
  const det: PreviewDetection = {
    framework: 'Next.js',
    command: 'npm',
    args: ['run', 'dev'],
    port: 3000,
    ready_pattern: 'Ready in',
  };

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'build-heal-wiring-'));
    await fsp.mkdir(path.join(dir, '.next'));
    await fsp.writeFile(path.join(dir, '.next', 'BUILD_ID'), 'dev-build-id');
    activePreviews.clear();
    resetBuildHealState('sess-heal-1');
    mockPostPreviewEvent.mockClear();
  });

  afterEach(async () => {
    activePreviews.clear();
    resetBuildHealState('sess-heal-1');
    vi.restoreAllMocks();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('kills + re-spawns the dev server (the preview_restart path) when a real build rewrites BUILD_ID', async () => {
    registerPreview('sess-heal-1', {
      sessionId: 'sess-heal-1',
      devServer: fakeProcess(),
      tunnel: null,
      url: 'https://x.trycloudflare.com',
      framework: 'Next.js',
      cwd: dir,
      detection: det,
    });

    const kill = vi.spyOn(previewSvc, 'killPreview').mockResolvedValue(undefined);
    const respawn = vi
      .spyOn(handlersMod, 'startPreviewFromDetection')
      .mockReturnValue(undefined);

    const ctx = makeCtx();
    handlersMod.maybeAttachBuildHeal(ctx, 'tok');

    // Watcher armed with the module's DEFAULT debounce (1.5s) — this proves
    // the wiring works end-to-end with the real defaults an actual preview
    // would use, not a test-only shortened one.
    await sleep(100); // let fs.watch attach
    await fsp.writeFile(path.join(dir, '.next', 'BUILD_ID'), 'prod-build-id');
    await sleep(2_200); // 1.5s debounce + fs event + restart-IIFE margin

    expect(kill).toHaveBeenCalledWith('sess-heal-1');
    expect(respawn).toHaveBeenCalledWith(ctx, det, 'tok');
    expect(mockPostPreviewEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-heal-1',
        type: 'preview_progress',
        payload: expect.objectContaining({ message: 'Rebuilt — restarting preview' }),
      }),
    );
  }, 10_000);

  it('does not attach for a non-Next.js framework', async () => {
    registerPreview('sess-heal-1', {
      sessionId: 'sess-heal-1',
      devServer: fakeProcess(),
      tunnel: null,
      url: 'https://x.trycloudflare.com',
      framework: 'Vite',
      cwd: dir,
      detection: { ...det, framework: 'Vite' },
    });
    const ctx = makeCtx();
    handlersMod.maybeAttachBuildHeal(ctx, 'tok');
    expect(activePreviews.get('sess-heal-1')?.buildHealStop).toBeUndefined();
  });

  it('killPreview tears the watcher down so a later marker change is a no-op', async () => {
    registerPreview('sess-heal-1', {
      sessionId: 'sess-heal-1',
      devServer: fakeProcess(),
      tunnel: null,
      url: 'https://x.trycloudflare.com',
      framework: 'Next.js',
      cwd: dir,
      detection: det,
    });
    const respawn = vi
      .spyOn(handlersMod, 'startPreviewFromDetection')
      .mockReturnValue(undefined);

    const ctx = makeCtx();
    handlersMod.maybeAttachBuildHeal(ctx, 'tok');
    await sleep(100);

    // The REAL killPreview (not spied here) closes the watcher's fs.watch
    // handle as part of teardown.
    await previewSvc.killPreview('sess-heal-1');

    await fsp.writeFile(path.join(dir, '.next', 'BUILD_ID'), 'prod-build-id');
    await sleep(2_200);

    expect(respawn).not.toHaveBeenCalled();
  }, 10_000);
});
