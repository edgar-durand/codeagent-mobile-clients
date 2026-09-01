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

  /**
   * ⚠️ La copia cambió el 2026-08-29 (a mejor), la CONDUCTA no: un puerto que
   * no sirve una app sigue sin spawnear nada y sigue emitiendo el error. Lo
   * que cambió es que ahora se distingue POR LO QUE SIRVE, así que el mensaje
   * puede decir la verdad — «something that isn't a dev server» — en vez de
   * llamar «otro proceso» a lo que muchas veces era el dev server del propio
   * usuario.
   */
  it('leaves a port that ISN\'T serving an app alone, with an actionable error', async () => {
    vi.spyOn(preview, 'isPortListening').mockResolvedValue(true);
    vi.spyOn(preview, 'canAdoptPort').mockResolvedValue({
      adopt: false,
      reason: 'unreachable',
    });
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
    expect(err?.payload.message).toContain("isn't a dev server");
  });

  /**
   * ⚠️ **EL caso que motivó el cambio.** Si lo que tiene el puerto ES el dev
   * server del proyecto —arrancado por el agente, o a mano en una terminal—
   * antes se moría con «port already in use» y el usuario se quedaba
   * atascado sin salida (replay de PostHog, 2026-08-29). Ahora se adopta: se
   * tunela lo que ya está sirviendo, sin spawnear un segundo servidor.
   */
  it('ADOPTA el dev server que ya está sirviendo en vez de morir', async () => {
    vi.spyOn(preview, 'isPortListening').mockResolvedValue(true);
    vi.spyOn(preview, 'canAdoptPort').mockResolvedValue({ adopt: true });
    vi.spyOn(preview, 'reclaimOwnOrphanPort').mockReturnValue(false);
    // Se corta en el túnel a propósito: lo que se quiere demostrar es que la
    // ejecución PASÓ DE LARGO por la rama del puerto, no que llegue a tunelar
    // (eso pide un cloudflared, y aquí no lo hay).
    vi.spyOn(preview, 'resolveCloudflared').mockRejectedValue(new Error('sin cloudflared'));

    const { events, emit } = collectEvents();
    await runPreviewStart({
      sessionId: 'sess-3',
      detection,
      cwd: '/tmp/fake-project',
      emit: emit as never,
    });

    // No se arranca un SEGUNDO servidor: el que hay ya sirve.
    expect(spawnSpy).not.toHaveBeenCalled();

    const err = events.find((e) => e.type.endsWith('preview_error'));
    // Y el error que sale es el del túnel, no el del puerto — o sea que la
    // adopción ocurrió.
    expect(err?.payload.stage).toBe('tunnel');
    expect(String(err?.payload.message)).not.toContain('in use');
  });
});