import { test, expect } from '@playwright/test';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { startInspectorProxy } from '../src/services/preview/inspector-proxy';
import { inspectorClientSource } from '../src/services/preview/inspector-client';

/**
 * El inspector de punta a punta, en un navegador de verdad.
 *
 * ⚠️ Esto es lo que ninguna de las otras dos capas puede demostrar. El proxy
 * se prueba contra sockets reales y el script se evalúa en un DOM, pero
 * ninguno responde a la pregunta que importa: **¿una página cargada a través
 * del proxy trae el script vivo, y un clic devuelve el elemento?** Para eso
 * hace falta un navegador ejecutando el HTML que el proxy realmente emite.
 *
 * El montaje reproduce el real: una página «padre» (el dashboard) que embebe
 * en un iframe la página del usuario servida A TRAVÉS del proxy, y que se
 * comunica con ella solo por `postMessage`. Nada de atajos: si el padre
 * pudiera tocar el DOM del hijo, el test no probaría el caso cross-origin que
 * es la razón de existir del proxy.
 */

/** La app del usuario: elementos reconocibles y en sitios conocidos. */
const APP_HTML = `<!doctype html>
<html><head><title>Fixture app</title><style>
  body{margin:0;font-family:system-ui}
  #cta{position:absolute;left:40px;top:60px;width:160px;height:44px}
</style></head>
<body>
  <h1 id="title">Elite Drive</h1>
  <button id="cta" class="btn primary">Contactar Ahora</button>
</body></html>`;

/** El dashboard: embebe el preview y habla con él solo por postMessage. */
const PARENT_HTML = (src: string) => `<!doctype html>
<html><head><title>Dashboard</title></head><body>
<iframe id="preview" src="${src}" style="width:600px;height:400px;border:0"></iframe>
<script>
  window.__picks = [];
  window.__ready = false;
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.source !== 'codeam-inspector') return;
    if (e.data.type === 'ready') { window.__ready = true; return; }
    if (e.data.type === 'pick') window.__picks.push(e.data.element);
  });
  window.__drive = function (type) {
    document.getElementById('preview').contentWindow.postMessage(
      { source: 'codeam-inspector', type: type }, '*'
    );
  };
</script>
</body></html>`;

interface Rig {
  parentUrl: string;
  close: () => Promise<void>;
}

/**
 * Levanta el montaje entero: la app del usuario, el proxy delante de ella, y
 * el dashboard que la embebe. Tres servidores, tres puertos, como en real.
 */
async function rig(): Promise<Rig> {
  const app = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(APP_HTML);
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const appPort = (app.address() as AddressInfo).port;

  // El dashboard se sirve antes que el proxy para conocer su origen: el script
  // lleva la lista blanca DENTRO, y sin el origen correcto no obedecería —
  // que es exactamente la guarda que queremos ver funcionando.
  const parent = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PARENT_HTML(`http://127.0.0.1:${proxyPort}/`));
  });
  await new Promise<void>((r) => parent.listen(0, '127.0.0.1', () => r()));
  const parentPort = (parent.address() as AddressInfo).port;
  const parentOrigin = `http://127.0.0.1:${parentPort}`;

  const proxy = await startInspectorProxy({
    targetPort: appPort,
    script: inspectorClientSource({ allowedOrigins: [parentOrigin] }),
  });
  // eslint-disable-next-line prefer-const
  var proxyPort = proxy.port;

  return {
    parentUrl: `${parentOrigin}/`,
    close: async () => {
      await proxy.close();
      await new Promise<void>((r) => parent.close(() => r()));
      await new Promise<void>((r) => app.close(() => r()));
    },
  };
}

test.describe('inspector — de punta a punta', () => {
  test('un clic en el preview devuelve el elemento al dashboard', async ({ page }) => {
    const r = await rig();
    try {
      await page.goto(r.parentUrl);
      const frame = page.frameLocator('#preview');
      await expect(frame.locator('#cta')).toBeVisible();

      // 1. El script llegó vivo con la página, a través del proxy.
      await page.evaluate(() => (window as never as { __drive: (t: string) => void }).__drive('enable'));
      await expect
        .poll(() => page.evaluate(() => (window as never as { __ready: boolean }).__ready))
        .toBe(true);

      // 2. Al pasar por encima, la página se resalta a sí misma — el aspecto
      //    del inspector del navegador, y pixel-exacto porque lo pinta quien
      //    conoce el layout.
      await frame.locator('#cta').hover();
      await expect(frame.locator('[data-codeam="inspector-overlay"]')).toBeVisible();
      await expect(frame.locator('[data-codeam="inspector-label"]')).toContainText('#cta');

      // 3. Y al pulsar, el dashboard recibe QUÉ se pulsó.
      //
      // ⚠️ Con espera activa, no leyendo justo después del clic: el
      // `postMessage` cruza de un origen a otro y llega en un turno posterior
      // del bucle de eventos. Leer a pelo pasaba unas veces y otras no — una
      // prueba intermitente es peor que ninguna.
      await frame.locator('#cta').click();
      await expect
        .poll(() => page.evaluate(() => (window as never as { __picks: unknown[] }).__picks.length))
        .toBe(1);
      const picks = await page.evaluate(
        () => (window as never as { __picks: Array<Record<string, unknown>> }).__picks,
      );
      expect(picks[0]).toMatchObject({
        tag: 'button',
        id: 'cta',
        classes: 'btn primary',
        selector: '#cta',
        text: 'Contactar Ahora',
      });

      // La caja real, medida por el navegador — no una aproximación nuestra.
      const rect = picks[0].rect as { x: number; y: number; w: number; h: number };
      expect(rect.x).toBeCloseTo(40, 0);
      expect(rect.y).toBeCloseTo(60, 0);
      expect(rect.w).toBeCloseTo(160, 0);
      expect(rect.h).toBeCloseTo(44, 0);
    } finally {
      await r.close();
    }
  });

  /**
   * ⚠️ Inerte hasta que lo enciendan, comprobado en el navegador.
   *
   * Es la promesa que le hacemos a la app de otra persona: mientras nadie lo
   * encienda, el preview se comporta como si no estuviéramos.
   */
  test('sin encender, la página se comporta como si no estuviéramos', async ({ page }) => {
    const r = await rig();
    try {
      await page.goto(r.parentUrl);
      const frame = page.frameLocator('#preview');
      await frame.locator('#cta').hover();
      await frame.locator('#cta').click();
      // Una espera real antes de afirmar el vacío: si no, se estaría
      // comprobando que un mensaje no ha llegado TODAVÍA, no que no llega.
      await expect(frame.locator('[data-codeam="inspector-overlay"]')).toHaveCount(0);
      await expect
        .poll(() => page.evaluate(() => (window as never as { __picks: unknown[] }).__picks.length))
        .toBe(0);
    } finally {
      await r.close();
    }
  });

  /**
   * Apagarlo tiene que quitar lo que PINTA y lo que ESCUCHA.
   *
   * ⚠️ La etiqueta `<script>` sí se queda, y debe: es el propio inspector, y
   * borrarla haría imposible volver a encenderlo sin recargar la página.
   *
   * Esto lo destapó el navegador. El test en jsdom evaluaba el CUERPO del
   * script sin su envoltorio, así que allí no existía ninguna etiqueta y un
   * `[data-codeam]` daba 0 — una diferencia entre lo que se prueba y lo que se
   * despliega que solo se ve ejecutando el HTML real que emite el proxy.
   */
  test('al apagarlo no queda nada pintado ni escuchando', async ({ page }) => {
    const r = await rig();
    try {
      await page.goto(r.parentUrl);
      const frame = page.frameLocator('#preview');
      const drive = (t: string) =>
        page.evaluate((x) => (window as never as { __drive: (t: string) => void }).__drive(x), t);

      await drive('enable');
      await frame.locator('#cta').hover();
      await expect(frame.locator('[data-codeam="inspector-overlay"]')).toBeVisible();

      await drive('disable');
      await expect(frame.locator('[data-codeam="inspector-overlay"]')).toHaveCount(0);
      await expect(frame.locator('[data-codeam="inspector-label"]')).toHaveCount(0);
      // El script sigue ahí, listo para volver a encenderse.
      await expect(frame.locator('script[data-codeam="inspector"]')).toHaveCount(1);

      await frame.locator('#cta').click();
      await expect
        .poll(() => page.evaluate(() => (window as never as { __picks: unknown[] }).__picks.length))
        .toBe(0);

      // Y se puede reencender sin recargar — que es para lo que la etiqueta
      // tiene que sobrevivir.
      await drive('enable');
      await frame.locator('#cta').click();
      await expect
        .poll(() => page.evaluate(() => (window as never as { __picks: unknown[] }).__picks.length))
        .toBe(1);
    } finally {
      await r.close();
    }
  });
});
