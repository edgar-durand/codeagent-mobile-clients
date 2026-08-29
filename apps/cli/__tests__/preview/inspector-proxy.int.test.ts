import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as net from 'net';
import * as zlib from 'zlib';
import type { AddressInfo } from 'net';
import {
  startInspectorProxy,
  injectAt,
  isHtmlResponse,
  wantsHtml,
  type InspectorProxy,
} from '../../src/services/preview/inspector-proxy';

/**
 * Tests del proxy del inspector contra un servidor de origen REAL — HTTP de
 * verdad, sockets de verdad, sin mocks de red.
 *
 * ⚠️ Estos tests no van sobre el inspector. Van sobre la TUBERÍA, que es donde
 * está todo el riesgo: el proxy se mete entre `cloudflared` y el dev server de
 * un usuario, así que un fallo aquí rompe un preview que hoy funciona. La
 * invariante es «transparente o ausente», y estos casos la vigilan uno por
 * uno:
 *
 *   - una API que devuelve JSON no nota que existimos
 *   - una imagen llega byte a byte idéntica
 *   - un SSE sigue llegando en streaming, no de golpe al final
 *   - un `Upgrade: websocket` (la recarga en caliente) se canaliza crudo
 *   - solo el HTML se toca, y solo una vez
 *
 * Si esto está verde, el proxy no puede romper un preview sano.
 */

const SCRIPT = '<script id="codeam-inspector">/*inspector*/</script>';

/** Un dev server de mentira que sirve de todo lo que sirve uno de verdad. */
function makeOrigin(): Promise<{ port: number; close: () => Promise<void> }> {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f]);

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';

    if (url === '/api/items') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: [1, 2, 3], note: '</head> no debe tocarse aquí' }));
      return;
    }
    if (url === '/logo.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) });
      res.end(PNG);
      return;
    }
    if (url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: uno\n\n');
      setTimeout(() => res.write('data: dos\n\n'), 30);
      setTimeout(() => res.end(), 60);
      return;
    }
    if (url === '/gzipped') {
      // Solo comprime si el cliente lo pidió — como cualquier dev server.
      const body = '<html><head><title>z</title></head><body>hola</body></html>';
      if ((req.headers['accept-encoding'] ?? '').includes('gzip')) {
        const gz = zlib.gzipSync(Buffer.from(body));
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        res.end(gz);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
      return;
    }
    if (url === '/streamed') {
      // SSR en streaming, como Next App Router: el HTML llega por trozos y el
      // `</head>` cae en el PRIMERO.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<html><head><title>s</title></head><body><div>uno');
      setTimeout(() => res.write('</div><div>dos</div>'), 30);
      setTimeout(() => res.end('</body></html>'), 60);
      return;
    }
    if (url === '/split-anchor') {
      // El `</head>` PARTIDO entre dos trozos de red. Si el proxy no acumula,
      // no lo encuentra y no inyecta nunca.
      res.writeHead(200, { 'content-type': 'text/html' });
      // ⚠️ El segundo trozo NO puede traer otro anclaje. Traía `<body>`, que
      // también lo es, así que se inyectaba en él sin acumular nada y el
      // experimento de control no podía fallar. Solo `</head>`, y partido.
      res.write('<html><head><title>p</title></he');
      setTimeout(() => res.end('ad>ok</html>'), 30);
      return;
    }
    if (url === '/fragment') {
      // HTML sin `<head>` ni `<body>`: no hay dónde anclar.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<div>solo un trozo</div>');
      return;
    }
    if (url === '/echo-headers') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ host: req.headers.host, custom: req.headers['x-custom'] }));
      return;
    }
    if (url === '/teapot') {
      res.writeHead(418, { 'content-type': 'text/plain', 'x-origin-header': 'kept' });
      res.end('soy una tetera');
      return;
    }

    // ⚠️ `content-length` EXPLÍCITO. Sin él Node usa `chunked` y borrarlo en
    // el proxy sería un no-op: el experimento de control no podía fallar y el
    // test no vigilaba nada. Un dev server real sí lo manda.
    const body = '<html><head><title>t</title></head><body>hola</body></html>';
    res.writeHead(200, {
      'content-type': 'text/html',
      'content-length': String(Buffer.byteLength(body)),
    });
    res.end(body);
  });

  /**
   * ⚠️ Tras un `upgrade`, Node DESACOPLA el socket del servidor: ni
   * `closeAllConnections()` ni `close()` lo alcanzan, así que el doble se
   * quedaba vivo para siempre y el `afterAll` expiraba. El doble tiene que
   * recoger su propia basura.
   */
  const upgradedHere = new Set<import('stream').Duplex>();

  // La recarga en caliente: contesta el apretón de manos y hace eco.
  server.on('upgrade', (_req, socket, head) => {
    upgradedHere.add(socket);
    socket.once('close', () => upgradedHere.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n');
    if (head?.length) socket.write(head);
    socket.on('data', (d: Buffer) => socket.write(Buffer.concat([Buffer.from('eco:'), d])));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((r) => {
            for (const s of upgradedHere) s.destroy();
            upgradedHere.clear();
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

interface Fetched {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  chunkTimes: number[];
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const parts: Buffer[] = [];
      const chunkTimes: number[] = [];
      const t0 = Date.now();
      res.on('data', (d: Buffer) => {
        parts.push(d);
        chunkTimes.push(Date.now() - t0);
      });
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(parts),
          chunkTimes,
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

const HTML_ACCEPT = { accept: 'text/html,application/xhtml+xml' };

describe('inspector proxy — la tubería', () => {
  let origin: { port: number; close: () => Promise<void> };
  let proxy: InspectorProxy;

  beforeAll(async () => {
    origin = await makeOrigin();
    proxy = await startInspectorProxy({ targetPort: origin.port, script: SCRIPT });
  });

  afterAll(async () => {
    await proxy.close();
    await origin.close();
  });

  // ── 1. Solo el HTML se toca ──────────────────────────────────────────

  it('inyecta el script en una navegación HTML', async () => {
    const res = await get(proxy.port, '/', HTML_ACCEPT);
    expect(res.body.toString()).toContain('codeam-inspector');
    // Y antes de `</head>`, no en cualquier sitio.
    const html = res.body.toString();
    expect(html.indexOf('codeam-inspector')).toBeLessThan(html.indexOf('</head>'));
  });

  it('lo inyecta UNA sola vez', async () => {
    const res = await get(proxy.port, '/', HTML_ACCEPT);
    const hits = res.body.toString().split('codeam-inspector').length - 1;
    expect(hits).toBe(1);
  });

  /**
   * ⚠️ El caso «proyecto de backend». Una API no sirve HTML, así que el proxy
   * tiene que ser una tubería y nada más. El JSON de este test lleva un
   * `</head>` DENTRO de una cadena a propósito: si alguien inyectara mirando
   * el cuerpo en vez del `Content-Type`, corrompería la respuesta.
   */
  it('un JSON de API pasa intacto, aunque contenga </head>', async () => {
    const res = await get(proxy.port, '/api/items', { accept: 'application/json' });
    expect(res.body.toString()).not.toContain('codeam-inspector');
    expect(JSON.parse(res.body.toString())).toEqual({
      items: [1, 2, 3],
      note: '</head> no debe tocarse aquí',
    });
  });

  it('una imagen llega byte a byte idéntica', async () => {
    const direct = await get(origin.port, '/logo.png');
    const viaProxy = await get(proxy.port, '/logo.png');
    expect(viaProxy.body.equals(direct.body)).toBe(true);
    expect(viaProxy.headers['content-type']).toBe('image/png');
  });

  // Aunque la petición ACEPTE html, si la respuesta no lo es no se toca. Es la
  // regla que protege a `fetch('/api/x', {headers:{accept:'*/*'}})` desde una
  // página, y a cualquier navegación que acabe en descarga.
  it('no toca una respuesta no-HTML aunque la petición aceptara HTML', async () => {
    const res = await get(proxy.port, '/api/items', HTML_ACCEPT);
    expect(res.body.toString()).not.toContain('codeam-inspector');
  });

  // ── 2. Streaming ─────────────────────────────────────────────────────

  /**
   * ⚠️ Un SSE tiene que llegar EN STREAMING. Si el proxy bufferizara, el
   * cliente recibiría todo de golpe al final: el mecanismo entero de eventos
   * en vivo del usuario quedaría roto de una forma que un test de contenido
   * no vería. Por eso se mide CUÁNDO llega cada trozo, no solo qué llega.
   */
  it('un SSE sigue llegando por trozos, no de golpe', async () => {
    const res = await get(proxy.port, '/events', { accept: 'text/event-stream' });
    expect(res.body.toString()).toContain('data: uno');
    expect(res.body.toString()).toContain('data: dos');
    expect(res.chunkTimes.length).toBeGreaterThan(1);
    // El segundo trozo lo manda el origen 30 ms después del primero.
    expect(res.chunkTimes[res.chunkTimes.length - 1]).toBeGreaterThanOrEqual(20);
  });

  it('el SSR en streaming se inyecta sin dejar de ser streaming', async () => {
    const res = await get(proxy.port, '/streamed', HTML_ACCEPT);
    const html = res.body.toString();
    expect(html).toContain('codeam-inspector');
    expect(html).toContain('<div>dos</div>');
    expect(res.chunkTimes.length).toBeGreaterThan(1);
  });

  // El anclaje puede caer partido entre dos paquetes. Sin acumular, el proxy
  // no lo vería y la página saldría sin inspector — un fallo intermitente que
  // depende del tamaño de los paquetes, o sea el peor de depurar.
  it('encuentra el anclaje partido entre dos trozos de red', async () => {
    const res = await get(proxy.port, '/split-anchor', HTML_ACCEPT);
    expect(res.body.toString()).toContain('codeam-inspector');
  });

  it('un fragmento HTML sin head ni body sale intacto', async () => {
    const res = await get(proxy.port, '/fragment', HTML_ACCEPT);
    expect(res.body.toString()).toBe('<div>solo un trozo</div>');
  });

  // ── 3. Cabeceras y estados ───────────────────────────────────────────

  /**
   * ⚠️ `Host` verbatim. Vite y Next comprueban el host de la petición y
   * `applyPreviewHostAllow` ya prepara el del túnel; si el proxy reescribiera
   * `Host` a `localhost`, esa preparación dejaría de casar y el dev server
   * respondería «Blocked request» a través del túnel.
   */
  it('reenvía las cabeceras verbatim, Host incluida', async () => {
    const res = await get(proxy.port, '/echo-headers', {
      host: 'preview-abc.codeagent-mobile.com',
      'x-custom': 'intacta',
    });
    expect(JSON.parse(res.body.toString())).toEqual({
      host: 'preview-abc.codeagent-mobile.com',
      custom: 'intacta',
    });
  });

  it('conserva el código de estado y las cabeceras del origen', async () => {
    const res = await get(proxy.port, '/teapot', HTML_ACCEPT);
    expect(res.status).toBe(418);
    expect(res.headers['x-origin-header']).toBe('kept');
  });

  // No se puede inyectar dentro de bytes comprimidos, así que en las
  // navegaciones se renuncia a la compresión — y el origen, al no verla
  // pedida, manda texto plano. Los assets conservan la suya.
  it('renuncia a la compresión solo para poder inyectar', async () => {
    const res = await get(proxy.port, '/gzipped', {
      ...HTML_ACCEPT,
      'accept-encoding': 'gzip, deflate, br',
    });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.toString()).toContain('codeam-inspector');
  });

  // Un `content-length` viejo con un cuerpo más largo trunca la página en el
  // navegador — y se ve como «la mitad de mi app no carga».
  it('no deja un content-length viejo al inyectar', async () => {
    const res = await get(proxy.port, '/', HTML_ACCEPT);
    expect(res.headers['content-length']).toBeUndefined();
    expect(res.body.toString()).toContain('</html>');
  });

  // ── 4. Recarga en caliente ───────────────────────────────────────────

  /**
   * ⚠️ EL fallo más probable del proxy entero. Vite y Next abren
   * `Upgrade: websocket` para el HMR; sin manejarlo, el socket muere y el
   * usuario ve un dev server que arranca pero «ya no refresca» — un síntoma
   * que nadie atribuye al proxy.
   */
  it('canaliza un Upgrade: websocket hasta el origen', async () => {
    const got = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxy.port, '127.0.0.1', () => {
        socket.write(
          'GET /hmr HTTP/1.1\r\n' +
            `Host: 127.0.0.1:${proxy.port}\r\n` +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
        );
      });
      let acc = '';
      socket.on('data', (d: Buffer) => {
        acc += d.toString();
        if (acc.includes('101')) socket.write('ping');
        if (acc.includes('eco:ping')) {
          socket.destroy();
          resolve(acc);
        }
      });
      socket.on('error', reject);
      setTimeout(() => {
        socket.destroy();
        reject(new Error(`sin respuesta al upgrade: ${JSON.stringify(acc)}`));
      }, 4000);
    });
    expect(got).toContain('101 Switching Protocols');
    expect(got).toContain('eco:ping');
  });

  // ── 5. El origen caído ───────────────────────────────────────────────

  it('responde 502 cuando el dev server no está, en vez de colgarse', async () => {
    const dead = await startInspectorProxy({ targetPort: 1, script: SCRIPT });
    try {
      const res = await get(dead.port, '/', HTML_ACCEPT);
      expect(res.status).toBe(502);
    } finally {
      await dead.close();
    }
  });
});

describe('inspector proxy — las decisiones puras', () => {
  it('reconoce una navegación por su Accept', () => {
    expect(wantsHtml('text/html,application/xhtml+xml')).toBe(true);
    expect(wantsHtml('application/json')).toBe(false);
    expect(wantsHtml(undefined)).toBe(false);
  });

  it('reconoce HTML con charset y en mayúsculas', () => {
    expect(isHtmlResponse('text/html; charset=utf-8')).toBe(true);
    expect(isHtmlResponse('TEXT/HTML')).toBe(true);
    expect(isHtmlResponse('application/json')).toBe(false);
    expect(isHtmlResponse(undefined)).toBe(false);
  });

  it('ancla antes de </head> cuando lo hay', () => {
    expect(injectAt('<head><title>x</title></head><body/>', 'S')).toBe(
      '<head><title>x</title>S</head><body/>',
    );
  });

  // Sin `<head>` todavía se puede: DENTRO de `<body>`, no antes.
  it('cae a <body> cuando no hay head', () => {
    expect(injectAt('<html><body>hola</body></html>', 'S')).toBe(
      '<html><body>Shola</body></html>',
    );
  });

  // `null` significa «sigue acumulando», no «no inyectes»: el anclaje puede
  // estar partido entre dos trozos.
  it('devuelve null cuando aún no hay anclaje', () => {
    expect(injectAt('<html><he', 'S')).toBeNull();
  });
});
