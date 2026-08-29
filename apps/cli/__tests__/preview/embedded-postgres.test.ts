import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { startEmbeddedPostgres } from '../../src/services/preview/embedded-postgres';

/**
 * Un Postgres EN PROCESO para las cajas donde no hay Docker.
 *
 * ⚠️ **Por qué existe.** El `docker run` de una Box de flota prohíbe
 * expresamente `--privileged`, el montaje de `docker.sock` y cualquier bind del
 * host (invariante de seguridad de `fleet_create_box`). Ahí Docker NUNCA va a
 * estar, así que un proyecto con Prisma arrancaba sin base de datos y el dev
 * server moría — sin que el usuario pudiera saber por qué (2026-08-29).
 *
 * PGlite es Postgres compilado a WASM y `pglite-socket` le pone un puerto que
 * habla su protocolo: para la app del usuario es un Postgres normal.
 */

function fakeChild(exitCode: number | null = null) {
  const c = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    kill: () => boolean;
    stderr: EventEmitter;
  };
  c.exitCode = exitCode;
  c.kill = vi.fn().mockReturnValue(true);
  c.stderr = new EventEmitter();
  return c;
}

describe('startEmbeddedPostgres', () => {
  it('arranca y reporta el puerto cuando responde', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const pg = await startEmbeddedPostgres({
      port: 5432,
      spawnFn: spawnFn as never,
      probe: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
    });
    expect(pg?.port).toBe(5432);
  });

  /**
   * ⚠️ Si ya hay alguien sirviendo ahí puede ser el propio Postgres del
   * usuario. Levantar otro encima solo daría un EADDRINUSE, y matar lo que
   * había sería peor.
   */
  it('no se levanta encima de algo que ya sirve', async () => {
    const spawnFn = vi.fn();
    const pg = await startEmbeddedPostgres({
      spawnFn: spawnFn as never,
      probe: vi.fn().mockResolvedValue(true),
    });
    expect(pg).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ El caso NORMAL en una caja con la imagen vieja: el `require` no
   * encuentra el paquete y el hijo muere. Eso no puede tumbar el arranque del
   * preview — es una mejora, no un requisito.
   */
  it('si el paquete no está, devuelve null en vez de lanzar', async () => {
    const child = fakeChild(1);
    const pg = await startEmbeddedPostgres({
      spawnFn: vi.fn().mockReturnValue(child) as never,
      probe: vi.fn().mockResolvedValue(false),
    });
    expect(pg).toBeNull();
  });

  it('si no está listo a tiempo, se rinde y mata al hijo', async () => {
    const child = fakeChild();
    const pg = await startEmbeddedPostgres({
      readyTimeoutMs: 300,
      spawnFn: vi.fn().mockReturnValue(child) as never,
      probe: vi.fn().mockResolvedValue(false),
    });
    expect(pg).toBeNull();
    expect(child.kill).toHaveBeenCalled();
  });

  // Se ejecuta con el MISMO node del CLI: en una Box no hay otro, y depender
  // de un `node` del PATH sería depender de algo que puede no estar.
  it('se ejecuta con el node del propio proceso', async () => {
    const spawnFn = vi.fn().mockReturnValue(fakeChild());
    await startEmbeddedPostgres({
      spawnFn: spawnFn as never,
      probe: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
    });
    expect(spawnFn.mock.calls[0][0]).toBe(process.execPath);
  });

  // Efímero a propósito: un preview es para mirar cómo queda algo, y una BD
  // que sobrevive arrastra el estado de la sesión anterior a la siguiente.
  it('la base es efímera', async () => {
    const spawnFn = vi.fn().mockReturnValue(fakeChild());
    await startEmbeddedPostgres({
      spawnFn: spawnFn as never,
      probe: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
    });
    expect(String(spawnFn.mock.calls[0][1][1])).toContain('memory://');
  });
});
