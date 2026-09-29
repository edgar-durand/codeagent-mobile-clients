import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewDetection } from '@codeam/shared';
import {
  clearActivePreviewMarker,
  readActivePreviewMarker,
  writeActivePreviewMarker,
} from '../../src/services/preview/active-marker';
import { restorePreviewAfterRestart } from '../../src/commands/start/handlers';

const detection = {
  framework: 'static',
  command: 'python3',
  args: ['-m', 'http.server', '8000'],
  port: 8000,
  ready_pattern: 'Serving',
} as PreviewDetection;

describe('preview active marker', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-preview-marker-'));
  });

  it('round-trips the detection and clears on an explicit stop', async () => {
    expect(await readActivePreviewMarker(cwd)).toBeNull();
    await writeActivePreviewMarker(cwd, detection);
    expect(await readActivePreviewMarker(cwd)).toEqual(detection);
    await clearActivePreviewMarker(cwd);
    expect(await readActivePreviewMarker(cwd)).toBeNull();
    await clearActivePreviewMarker(cwd); // idempotent
  });

  it('a corrupt marker reads as nothing to restore', async () => {
    fs.mkdirSync(path.join(cwd, '.codeam'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.codeam', 'preview-active.json'), '{not json');
    expect(await readActivePreviewMarker(cwd)).toBeNull();
  });
});

describe('restorePreviewAfterRestart', () => {
  const ctx = { sessionId: 's1', pluginId: 'p1' };

  it('starts the marked preview through the normal pipeline, as a user-origin preview', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const ok = await restorePreviewAfterRestart(ctx, 'tok', { read: async () => detection, start });
    expect(ok).toBe(true);
    expect(start).toHaveBeenCalledWith(ctx, detection, 'tok', { origin: 'user' });
  });

  it('does nothing without a marker', async () => {
    const start = vi.fn();
    expect(await restorePreviewAfterRestart(ctx, 'tok', { read: async () => null, start })).toBe(
      false,
    );
    expect(start).not.toHaveBeenCalled();
  });
});
