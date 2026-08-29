import * as http from 'http';
import * as net from 'net';
import type { AddressInfo } from 'net';

/**
 * El proxy del inspector: se pone entre `cloudflared` y el dev server del
 * usuario para poder inyectar el script que resalta elementos.
 *
 *     Antes:  cloudflared ──► :3000 (dev server)
 *     Ahora:  cloudflared ──► :PROXY ──► :3000 (dev server)
 *
 * Existe porque el preview se sirve por túnel, o sea cross-origin, y desde el
 * dashboard NO se puede leer su DOM. Sin inyectar, señalar se queda en dibujar
 * un rectángulo y mandar coordenadas; con el script inyectado el agente recibe
 * el ELEMENTO — etiqueta, clases, texto y, en dev con React, fichero y línea.
 *
 * ⚠️ **La invariante: transparente o ausente.** Nos estamos metiendo en el
 * camino del dev server de alguien, así que cualquier fallo aquí degrada un
 * preview que hoy funciona. De ahí las tres reglas, y los tests que las
 * vigilan una por una:
 *
 *  1. **Solo se inyecta en `text/html`.** Todo lo demás —JSON de una API,
 *     imágenes, JS, CSS, SSE— es tubería pura, byte a byte. Un proyecto de
 *     backend no nota que existimos.
 *  2. **Los websockets se canalizan crudos.** Vite y Next abren `Upgrade:
 *     websocket` para la recarga en caliente; sin manejar `upgrade` el HMR
 *     muere y el usuario ve un dev server que «ya no refresca». Es el fallo
 *     más probable de todos.
 *  3. **El SSR en streaming se respeta.** Se inyecta en el PRIMER trozo, no
 *     bufferizando la respuesta entera: Next App Router manda el HTML por
 *     partes y esperar al final mataría el streaming.
 *
 * Y una cuarta que no es regla sino consecuencia: las cabeceras se reenvían
 * **verbatim, `Host` incluida**, para que el chequeo de host de Vite/Next
 * —que `applyPreviewHostAllow` ya prepara contra el hostname del túnel— siga
 * funcionando exactamente igual.
 */

/**
 * Cuánto HTML se acumula buscando el punto de inyección antes de rendirse.
 *
 * Si `</head>` no ha aparecido en 64 KB, o no es un documento normal o su
 * cabecera es descomunal; en cualquier caso se suelta lo acumulado tal cual y
 * el resto se canaliza. Nunca se retiene la respuesta entera: eso es lo que
 * rompería el streaming.
 */
const INJECTION_SCAN_BUDGET_BYTES = 64 * 1024;

/** Dónde se inserta, por orden de preferencia. */
const INJECTION_ANCHORS = ['</head>', '<body>', '</body>'] as const;

export interface InspectorProxyOptions {
  /** Puerto del dev server del usuario. */
  targetPort: number;
  /** El `<script>` completo a inyectar, etiquetas incluidas. */
  script: string;
  /** Host del dev server. Solo para tests; en producción es localhost. */
  targetHost?: string;
}

export interface InspectorProxy {
  /** Puerto que se le pasa al túnel EN LUGAR del del dev server. */
  readonly port: number;
  close(): Promise<void>;
}

/** ¿Esta petición es una navegación que puede acabar en HTML inyectable? */
export function wantsHtml(accept: string | undefined): boolean {
  return typeof accept === 'string' && accept.includes('text/html');
}

/** ¿Esta respuesta es HTML? Tolera `; charset=utf-8` y mayúsculas. */
export function isHtmlResponse(contentType: string | undefined): boolean {
  return typeof contentType === 'string' && contentType.toLowerCase().includes('text/html');
}

/**
 * Inserta el script en el primer punto de anclaje que aparezca.
 *
 * Devuelve `null` cuando todavía no hay anclaje: el llamador entonces sigue
 * acumulando (hasta el presupuesto) en vez de escribir nada, porque el
 * anclaje puede estar partido entre dos trozos de la red.
 */
export function injectAt(html: string, script: string): string | null {
  for (const anchor of INJECTION_ANCHORS) {
    const at = html.indexOf(anchor);
    if (at === -1) continue;
    // Antes de `</head>` y `</body>`; DESPUÉS de `<body>`.
    const insertAt = anchor.startsWith('</') ? at : at + anchor.length;
    return html.slice(0, insertAt) + script + html.slice(insertAt);
  }
  return null;
}

export async function startInspectorProxy(
  opts: InspectorProxyOptions,
): Promise<InspectorProxy> {
  const targetHost = opts.targetHost ?? '127.0.0.1';

  /**
   * Los sockets ASCENDIDOS (websockets de recarga en caliente).
   *
   * ⚠️ `server.close()` deja de aceptar conexiones nuevas pero NO mata las ya
   * ascendidas: un websocket de HMR abierto mantiene el proceso vivo para
   * siempre. Y este `close()` está en el camino de `killPreview` (túnel →
   * proxy → dev server), así que un cierre que no termina deja el parar del
   * preview colgado — que es justo lo que el usuario pulsa cuando algo va mal.
   */
  const upgraded = new Set<import('stream').Duplex>();

  const server = http.createServer((req, res) => {
    const inject = wantsHtml(req.headers.accept);
    const headers = { ...req.headers };

    // ⚠️ No se puede inyectar dentro de bytes comprimidos. Se renuncia a la
    // compresión SOLO en las navegaciones; los assets —que son la mayor parte
    // del peso— conservan la suya intacta.
    if (inject) delete headers['accept-encoding'];

    const upstream = http.request(
      { host: targetHost, port: opts.targetPort, method: req.method, path: req.url, headers },
      (originRes) => {
        const outHeaders = { ...originRes.headers };
        const willInject = inject && isHtmlResponse(originRes.headers['content-type']);

        // Al inyectar cambia el largo, así que se quita y Node pasa a
        // `chunked`. Dejar un `content-length` viejo trunca la página.
        if (willInject) delete outHeaders['content-length'];
        res.writeHead(originRes.statusCode ?? 502, outHeaders);

        if (!willInject) {
          originRes.pipe(res);
          return;
        }

        // Inyección en el primer trozo: se acumula solo hasta encontrar el
        // anclaje, y a partir de ahí se canaliza. El streaming sobrevive.
        let buffered = '';
        let done = false;
        originRes.setEncoding('utf8');
        originRes.on('data', (chunk: string) => {
          if (done) {
            res.write(chunk);
            return;
          }
          buffered += chunk;
          const injected = injectAt(buffered, opts.script);
          if (injected !== null) {
            done = true;
            res.write(injected);
            buffered = '';
            return;
          }
          if (buffered.length >= INJECTION_SCAN_BUDGET_BYTES) {
            // Sin anclaje a la vista: se suelta lo acumulado sin tocarlo.
            done = true;
            res.write(buffered);
            buffered = '';
          }
        });
        originRes.on('end', () => {
          // El documento terminó antes de que apareciera el anclaje (un
          // fragmento HTML, por ejemplo): se emite tal cual, sin inyectar.
          if (!done && buffered.length > 0) res.write(buffered);
          res.end();
        });
      },
    );

    // El dev server se cayó o rechazó: se responde 502 en vez de dejar la
    // petición colgada. Es lo mismo que vería el usuario sin proxy.
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('preview origin unreachable');
    });
    req.pipe(upstream);
  });

  /**
   * ⚠️ La recarga en caliente pasa por aquí.
   *
   * Vite y Next abren un websocket para HMR. Sin esto el `Upgrade` se queda
   * sin respuesta, el socket muere y el usuario ve un dev server que arranca
   * pero «ya no refresca» — el fallo más probable de todo el proxy, y el más
   * difícil de atribuir. Se canaliza en crudo: no se interpreta ni un byte.
   */
  server.on('upgrade', (req, clientSocket, head) => {
    upgraded.add(clientSocket);

    const upstream = net.connect(opts.targetPort, targetHost, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(req.headers)) {
        for (const one of Array.isArray(v) ? v : [v]) {
          if (one !== undefined) lines.push(`${k}: ${one}`);
        }
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    /**
     * ⚠️ Los dos sockets mueren JUNTOS, y también en el cierre normal — no
     * solo en el error.
     *
     * Un `pipe` no propaga la destrucción: al cerrarse el del cliente, el
     * saliente hacia el dev server se quedaba huérfano. Eso es una fuga por
     * cada conexión de recarga en caliente, y además impedía que el propio
     * dev server terminara de cerrar cuando se para el preview.
     */
    const drop = () => {
      upgraded.delete(clientSocket);
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on('error', drop);
    upstream.on('close', drop);
    clientSocket.on('error', drop);
    clientSocket.on('close', drop);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Solo 127.0.0.1: la única puerta pública sigue siendo el túnel, igual
    // que hoy. El proxy no abre ninguna nueva.
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const port = (server.address() as AddressInfo).port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of upgraded) socket.destroy();
        upgraded.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
