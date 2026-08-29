import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import {
  activePreviews,
  registerPreview,
  killPreview,
} from '../../src/services/preview/index';

/**
 * El apagado tiene que cerrar el proxy del inspector, y en su sitio.
 *
 * ⚠️ Un servidor HTTP nuestro escuchando en localhost, con websockets de
 * recarga en caliente abiertos, mantiene el proceso VIVO si nadie lo mata. Sin
 * esto, parar el preview dejaría el puerto ocupado y el siguiente arranque se
 * encontraría un «port already in use» que nadie sabría explicar.
 */

function fakeChild(): ChildProcess {
  const c = new EventEmitter() as unknown as ChildProcess;
  // Un pid altísimo que no existe: `process.kill` lanza ESRCH y
  // `killProcessTree` se lo traga.
  //
  // ⚠️ Aquí ponía `0`, y `process.kill(-0, …)` señaliza al GRUPO DE PROCESOS
  // ACTUAL: el test mataba a su propio runner (exit 144, sin salida). De ahí
  // salió la guarda `!pid` en `killProcessTree`.
  (c as unknown as { pid: number }).pid = 2 ** 30;
  (c as unknown as { kill: () => boolean }).kill = () => true;
  return c;
}

afterEach(() => {
  activePreviews.clear();
  vi.restoreAllMocks();
});

describe('killPreview — el inspector', () => {
  it('cierra el proxy', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    registerPreview('s1', {
      sessionId: 's1',
      devServer: fakeChild(),
      tunnel: null,
      inspector: { close },
      url: 'https://x.test',
      framework: 'Next.js',
      detection: { framework: 'Next.js', command: 'npm', args: [], port: 3000 } as never,
      cwd: process.cwd(),
    });
    await killPreview('s1');
    expect(close).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠️ El túnel PRIMERO. Al revés, el túnel se quedaría un instante apuntando
   * a un puerto muerto y el usuario vería un 502 justo al pulsar «parar» — un
   * error que parece un fallo cuando es el apagado normal.
   */
  it('cierra el proxy DESPUÉS del túnel', async () => {
    const order: string[] = [];
    const tunnel = fakeChild();
    (tunnel as unknown as { kill: () => boolean }).kill = () => {
      order.push('tunnel');
      return true;
    };
    registerPreview('s2', {
      sessionId: 's2',
      devServer: fakeChild(),
      tunnel,
      inspector: {
        close: async () => {
          order.push('inspector');
        },
      },
      url: 'https://x.test',
      framework: 'Next.js',
      detection: { framework: 'Next.js', command: 'npm', args: [], port: 3000 } as never,
      cwd: process.cwd(),
    });
    await killPreview('s2');
    expect(order).toEqual(['tunnel', 'inspector']);
  });

  // Best-effort: un cierre que falle no puede impedir que se mate el proceso
  // que de verdad hay que matar.
  it('un cierre que falla no bloquea el apagado', async () => {
    const dev = fakeChild();
    const killed = vi.fn().mockReturnValue(true);
    (dev as unknown as { kill: unknown }).kill = killed;
    registerPreview('s3', {
      sessionId: 's3',
      devServer: dev,
      tunnel: null,
      inspector: { close: async () => { throw new Error('boom'); } },
      url: 'https://x.test',
      framework: 'Next.js',
      detection: { framework: 'Next.js', command: 'npm', args: [], port: 3000 } as never,
      cwd: process.cwd(),
    });
    await expect(killPreview('s3')).resolves.toBeUndefined();
    expect(killed).toHaveBeenCalled();
    expect(activePreviews.has('s3')).toBe(false);
  });

  // El camino directo (Expo, o el proxy no arrancó) no debe romper nada.
  it('sin inspector el apagado es el de siempre', async () => {
    registerPreview('s4', {
      sessionId: 's4',
      devServer: fakeChild(),
      tunnel: null,
      url: 'https://x.test',
      framework: 'Expo',
      detection: { framework: 'Expo', command: 'npx', args: [], port: 8081 } as never,
      cwd: process.cwd(),
    });
    await expect(killPreview('s4')).resolves.toBeUndefined();
    expect(activePreviews.has('s4')).toBe(false);
  });
});
