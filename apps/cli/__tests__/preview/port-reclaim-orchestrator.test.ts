/**
 * Orchestrator wiring for the cross-restart port reclaim (Rafael 2026-07-14).
 *
 * A dev server orphaned by a prior CLI (relay restart / hard-kill) holds the
 * port but is absent from THIS process's in-memory `activePreviews`. Before
 * the fix it was classified as a FOREIGN process and dead-ended, forcing the
 * user to ask the agent to free the port. Now `startDevServer` consults the
 * persistent registry via `reclaimOwnOrphanPort` and self-heals our own
 * orphan — while a genuinely foreign squatter still surfaces the actionable
 * error.
 *
 * Both cases here keep `isPortListening` true so the pipeline returns before
 * any real `spawn` — the assertion is purely which BRANCH ran (foreign error
 * vs reclaim-then-wait error), which is the exact misclassification fixed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as preview from '../../src/services/preview';
import { runPreviewStart } from '../../src/services/preview/start-orchestrator';
import type { PreviewDetection } from '@codeam/shared';

const spawnSpy = vi.fn();
vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return { ...actual, default: actual, spawn: (...a: unknown[]) => spawnSpy(...a) };
});

const detection: PreviewDetection = {
  framework: 'Next.js',
  command: 'npm',
  args: ['run', 'dev'],
  port: 3000,
  ready_pattern: 'ready',
};

function collectEvents() {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    emit: (type: string, payload: Record<string, unknown>) => {
      events.push({ type, payload });
    },
  };
}

beforeEach(() => {
  spawnSpy.mockReset();
  vi.spyOn(process, 'cwd').mockReturnValue('/tmp/fake-project');
  // Deps already present → provisionDeps is a no-op fast path.
  vi.spyOn(preview, 'detectMissingNodeDeps').mockReturnValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  preview.activePreviews.clear();
});

describe('startDevServer cross-restart port reclaim', () => {
  it('reclaims our OWN cross-restart orphan instead of erroring foreign', async () => {
    // Port busy for the whole run (so we return before any spawn), NOT in the
    // in-memory registry, but the persistent registry says it's ours.
    vi.spyOn(preview, 'isPortListening').mockResolvedValue(true);
    const reclaim = vi.spyOn(preview, 'reclaimOwnOrphanPort').mockReturnValue(true);

    const { events, emit } = collectEvents();
    await runPreviewStart({
      sessionId: 'sess-1',
      detection,
      cwd: '/tmp/fake-project',
      emit: emit as never,
    });

    // We consulted the persistent registry and it reclaimed OUR orphan.
    expect(reclaim).toHaveBeenCalledWith(3000);
    // Never spawned a rogue dev server while the port was still held.
    expect(spawnSpy).not.toHaveBeenCalled();
    // The error is the reclaim-then-wait one (port didn't free in the test),
    // NOT the foreign "stop whatever is listening" message.
    const err = events.find((e) => e.type.endsWith('preview_error'));
    expect(err?.payload.message).toContain('after stopping the previous preview');
    expect(err?.payload.message).not.toContain('another process');
  });

  it('leaves a genuinely FOREIGN port alone and surfaces the actionable error', async () => {
    vi.spyOn(preview, 'isPortListening').mockResolvedValue(true);
    const reclaim = vi.spyOn(preview, 'reclaimOwnOrphanPort').mockReturnValue(false);

    const { events, emit } = collectEvents();
    await runPreviewStart({
      sessionId: 'sess-2',
      detection,
      cwd: '/tmp/fake-project',
      emit: emit as never,
    });

    expect(reclaim).toHaveBeenCalledWith(3000);
    expect(spawnSpy).not.toHaveBeenCalled();
    const err = events.find((e) => e.type.endsWith('preview_error'));
    expect(err?.payload.message).toContain('already in use by another process');
  });
});
