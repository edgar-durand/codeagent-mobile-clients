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
  let home: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-preview-marker-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-preview-home-'));
  });

  it('round-trips the detection, clears on an explicit stop, and never touches the project tree', async () => {
    expect(await readActivePreviewMarker(cwd, home)).toBeNull();
    await writeActivePreviewMarker(cwd, detection, home);
    expect(await readActivePreviewMarker(cwd, home)).toEqual(detection);
    // Machine state lives under ~/.codeam, not inside the (committable) project.
    expect(fs.existsSync(path.join(cwd, '.codeam'))).toBe(false);
    expect(fs.readdirSync(path.join(home, '.codeam', 'preview-active'))).toHaveLength(1);
    await clearActivePreviewMarker(cwd, home);
    expect(await readActivePreviewMarker(cwd, home)).toBeNull();
    await clearActivePreviewMarker(cwd, home); // idempotent
  });

  it('two workspaces get two markers', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-preview-marker-'));
    await writeActivePreviewMarker(cwd, detection, home);
    expect(await readActivePreviewMarker(other, home)).toBeNull();
  });

  it('a corrupt marker reads as nothing to restore', async () => {
    await writeActivePreviewMarker(cwd, detection, home);
    const dir = path.join(home, '.codeam', 'preview-active');
    const [file] = fs.readdirSync(dir);
    fs.writeFileSync(path.join(dir, file), '{not json');
    expect(await readActivePreviewMarker(cwd, home)).toBeNull();
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
