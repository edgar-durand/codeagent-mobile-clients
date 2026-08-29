import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

/**
 * ⚠️ Un watcher que muere no puede llevarse el proceso por delante.
 *
 * `defaultWatchDir` envolvía `fs.watch` en un `try/catch` y su comentario
 * prometía degradar cuando el directorio se borrara «mid-watch». Pero ese
 * `catch` solo cubre la llamada SÍNCRONA: una vez creado el watcher, el
 * directorio borrado o un `EPERM` de Windows llegan como evento `'error'`, y
 * un `FSWatcher` sin listener de error lanza una excepción NO CAPTURADA que
 * mata el proceso.
 *
 * En producción: borrar `.next`, cambiar de rama o mover el proyecto mientras
 * corre un preview se llevaba el CLI entero.
 *
 * Se vio en el CI de Windows —2655 tests en verde y la ejecución en rojo por
 * una excepción suelta, `EPERM: operation not permitted, watch`— y llevaba
 * fallando desde el 2026-08-27.
 */

const watch = vi.fn();
vi.mock('fs', () => ({ watch: (...a: unknown[]) => watch(...a) }));

// `vi.mock` se iza, asi que un import normal ya ve el modulo mockeado — y
// evita el `await` de nivel superior, que este tsconfig no admite.
import { defaultWatchDir } from '../../src/services/preview/build-heal';

/** Un `FSWatcher` de mentira que se puede hacer fallar a voluntad. */
function fakeWatcher() {
  const w = new EventEmitter() as EventEmitter & { close: () => void };
  w.close = vi.fn();
  return w;
}

afterEach(() => watch.mockReset());

describe('defaultWatchDir', () => {
  it('sobrevive a un error POSTERIOR en vez de tumbar el proceso', () => {
    const w = fakeWatcher();
    watch.mockReturnValue(w);
    defaultWatchDir('/tmp/x', () => {});

    // Sin listener de `'error'`, este emit lanzaría: un EventEmitter sin
    // handler de error convierte el evento en excepción.
    expect(() =>
      w.emit('error', Object.assign(new Error('EPERM'), { code: 'EPERM' })),
    ).not.toThrow();
  });

  it('cierra el watcher cuando muere, para no dejar el handle colgando', () => {
    const w = fakeWatcher();
    watch.mockReturnValue(w);
    defaultWatchDir('/tmp/x', () => {});
    w.emit('error', new Error('EPERM'));
    expect(w.close).toHaveBeenCalled();
  });

  // `killPreview` llama a `stop` sin saber en qué estado está el watcher, así
  // que pararlo dos veces —o parar algo ya muerto— no es un error que nadie
  // deba ver.
  it('parar dos veces no lanza', () => {
    const w = fakeWatcher();
    (w.close as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('already closed');
    });
    watch.mockReturnValue(w);
    const stop = defaultWatchDir('/tmp/x', () => {});
    expect(() => {
      stop?.();
      stop?.();
    }).not.toThrow();
  });

  // El camino síncrono sigue como estaba: si no se puede ni empezar a mirar,
  // se degrada a «sin auto-heal», no se revienta el arranque del preview.
  it('un fallo síncrono sigue degradando a null', () => {
    watch.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(defaultWatchDir('/tmp/x', () => {})).toBeNull();
  });

  it('los eventos normales siguen llegando al llamador', () => {
    const w = fakeWatcher();
    watch.mockImplementation(
      (_d: string, _o: unknown, cb: (e: string, f: string | null) => void) => {
        setTimeout(() => cb('rename', 'BUILD_ID'), 0);
        return w;
      },
    );
    const seen: (string | null)[] = [];
    defaultWatchDir('/tmp/x', (f) => seen.push(f));
    return new Promise<void>((r) =>
      setTimeout(() => {
        expect(seen).toEqual(['BUILD_ID']);
        r();
      }, 5),
    );
  });
});
