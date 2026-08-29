import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';

/**
 * Un Postgres EN PROCESO para las cajas donde no hay Docker.
 *
 * ⚠️ **Por qué existe.** El `docker run` de una Box de flota prohíbe
 * expresamente `--privileged`, el montaje de `docker.sock` y cualquier bind
 * del host (invariante de seguridad de `fleet_create_box`). Ahí no hay Docker
 * que valga, así que un proyecto con Prisma arrancaba sin base de datos y el
 * dev server moría — sin que el usuario pudiera saber por qué.
 *
 * PGlite es Postgres compilado a WASM: corre dentro de un proceso Node, sin
 * demonio y sin permisos especiales. `pglite-socket` le pone un puerto TCP que
 * habla el protocolo de Postgres, así que para la app del usuario es un
 * Postgres normal y su `DATABASE_URL=postgres://…` no cambia ni una letra.
 *
 * ⚠️ Los paquetes vienen PRE-INSTALADOS en la imagen de la Box (`apps/box/
 * Dockerfile`), igual que el CLI, los agentes y el modelo de Headroom.
 * Bajarlos en el primer preview metería su descarga en el camino crítico del
 * usuario. Si no están —una caja vieja, o un `codeam start` local— esto
 * devuelve `null` y el preview sigue por donde iba: es una mejora, no un
 * requisito.
 *
 * ⚠️ Y es EFÍMERO a propósito: en memoria, muere con la sesión. Un preview es
 * para mirar cómo queda algo, no para guardar datos — y una BD que sobrevive
 * arrastra el estado de la sesión anterior al siguiente que la abra.
 */

/** El programa que se ejecuta. Se escribe en una línea para no llevar fichero. */
const BOOT = `
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
(async () => {
  // 'memory://' — efímero por diseño; ver el comentario del módulo.
  const db = await PGlite.create('memory://');
  const server = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1' });
  await server.start();
  process.on('SIGTERM', async () => { await server.stop(); process.exit(0); });
})().catch((e) => { console.error(String(e && e.message)); process.exit(1); });
`;

export interface EmbeddedPostgres {
  port: number;
  stop: () => void;
}

/** ¿Hay ya alguien escuchando ahí? */
function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net
      .connect({ host: '127.0.0.1', port }, () => {
        s.destroy();
        resolve(true);
      })
      .on('error', () => resolve(false));
    s.setTimeout(1_000, () => {
      s.destroy();
      resolve(false);
    });
  });
}

export interface StartOptions {
  port?: number;
  /** Cuánto se espera a que el puerto responda. */
  readyTimeoutMs?: number;
  /** Inyectable para poder probar sin abrir puertos. */
  spawnFn?: typeof spawn;
  probe?: (port: number) => Promise<boolean>;
  log?: (message: string) => void;
}

const DEFAULT_PORT = 5432;

/**
 * Levanta el Postgres embebido. Devuelve `null` si no se puede —los paquetes
 * no están, el puerto está ocupado, no arranca a tiempo— y NUNCA lanza: esto
 * es un extra, y su fallo no puede tumbar el arranque del preview.
 */
export async function startEmbeddedPostgres(
  opts: StartOptions = {},
): Promise<EmbeddedPostgres | null> {
  const port = opts.port ?? DEFAULT_PORT;
  const probe = opts.probe ?? isListening;
  const log = opts.log ?? (() => undefined);

  // Alguien ya sirve ahí: puede ser el propio Postgres del usuario. Levantar
  // otro encima solo daría un EADDRINUSE.
  if (await probe(port)) {
    log(`embedded postgres skipped — port ${port} already serving`);
    return null;
  }

  const child = (opts.spawnFn ?? spawn)(
    process.execPath,
    ['-e', `const PORT=${port};${BOOT}`],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: false },
  );

  let failure = '';
  child.stderr?.on('data', (d: Buffer) => {
    failure += String(d).slice(0, 400);
  });

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      // El caso normal en una caja sin la imagen nueva: el `require` no
      // encuentra el paquete. No es un error que merezca ruido.
      log(`embedded postgres unavailable (${failure.trim() || 'exited'})`);
      return null;
    }
    if (await probe(port)) {
      log(`embedded postgres serving on ${port}`);
      return { port, stop: () => stopChild(child) };
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  log('embedded postgres did not become ready in time');
  stopChild(child);
  return null;
}

function stopChild(child: ChildProcess): void {
  try {
    child.kill('SIGTERM');
  } catch {
    /* ya estaba muerto */
  }
}
