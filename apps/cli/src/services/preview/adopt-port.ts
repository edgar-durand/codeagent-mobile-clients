import * as http from 'http';

/**
 * Decide si el proceso que ya escucha en el puerto del preview es el dev
 * server DE ESTE PROYECTO —y por tanto se puede adoptar— o algo ajeno.
 *
 * ⚠️ **Por qué existe.** Antes había dos únicas salidas: si el puerto era
 * nuestro se reutilizaba, y en cualquier otro caso el preview moría con «Port
 * N is already in use by another process. Stop whatever is listening…». Esa
 * segunda rama asumía «ajeno», y el caso MUCHO más frecuente es el contrario:
 * el dev server del propio proyecto, arrancado por el agente o a mano en una
 * terminal. Eso no es ajeno — es exactamente lo que se quiere previsualizar.
 * Un usuario se quedó atascado ahí (replay de PostHog, 2026-08-29).
 *
 * ⚠️ Pero adoptar A CIEGAS reintroduciría el fallo que motivó ese error: un
 * `http.server` olvidado en `:3000` sirviendo un listado de `/tmp`, tunelado
 * al mundo como si fuera la app del usuario. Por eso no se adopta por el hecho
 * de que algo escuche, sino por lo que ese algo SIRVE.
 */

export type AdoptVerdict =
  | { adopt: true }
  | { adopt: false; reason: 'unreachable' | 'not-html' | 'directory-listing' };

/**
 * La firma de un listado de directorios de `http.server` de Python y de los
 * equivalentes de otros lenguajes. Es el caso que hay que rechazar por su
 * nombre: no es una app, es un explorador de ficheros.
 */
const DIRECTORY_LISTING_RE = /<title>\s*(?:Directory listing for|Index of)/i;

/** Cuánto se espera. Es localhost: si tarda más, no está sirviendo. */
const PROBE_TIMEOUT_MS = 2_000;

/** Solo se mira el principio del cuerpo — el `<title>` va en la cabecera. */
const PROBE_BODY_LIMIT = 4 * 1024;

export interface ProbeResponse {
  contentType: string | undefined;
  bodyStart: string;
}

/** Inyectable para poder probar el veredicto sin abrir puertos. */
export type ProbePortFn = (port: number) => Promise<ProbeResponse | null>;

export function verdictFor(res: ProbeResponse | null): AdoptVerdict {
  if (!res) return { adopt: false, reason: 'unreachable' };

  // Un preview sirve una interfaz. Lo que devuelve JSON o binario en la raiz
  // no es el dev server que se quiere enseñar, y tunelarlo seria enseñar otra
  // cosa.
  if (!res.contentType || !res.contentType.toLowerCase().includes('text/html')) {
    return { adopt: false, reason: 'not-html' };
  }

  if (DIRECTORY_LISTING_RE.test(res.bodyStart)) {
    return { adopt: false, reason: 'directory-listing' };
  }

  return { adopt: true };
}

/** Pide la raiz del puerto y devuelve lo justo para decidir. */
export const probePort: ProbePortFn = (port) =>
  new Promise<ProbeResponse | null>((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/', timeout: PROBE_TIMEOUT_MS },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          if (body.length < PROBE_BODY_LIMIT) body += c;
        });
        res.on('end', () =>
          resolve({ contentType: res.headers['content-type'], bodyStart: body }),
        );
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });

/**
 * ¿Se puede adoptar lo que ya escucha en este puerto?
 *
 * Nunca lanza: si la sonda falla por lo que sea, el veredicto es no adoptar —
 * o sea, exactamente el comportamiento que habia antes.
 */
export async function canAdoptPort(
  port: number,
  probe: ProbePortFn = probePort,
): Promise<AdoptVerdict> {
  try {
    return verdictFor(await probe(port));
  } catch {
    return { adopt: false, reason: 'unreachable' };
  }
}
