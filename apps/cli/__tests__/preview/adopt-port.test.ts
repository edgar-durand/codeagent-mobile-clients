import { describe, it, expect, vi } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { canAdoptPort, verdictFor, probePort } from '../../src/services/preview/adopt-port';

/**
 * ⚠️ Adoptar el dev server que ya está corriendo, en vez de morir.
 *
 * Antes solo había dos salidas: si el puerto era nuestro se reutilizaba, y en
 * cualquier otro caso el preview moría con «Port N is already in use by
 * another process». Esa rama asumía «ajeno», y el caso MUCHO más frecuente es
 * el contrario — el dev server del propio proyecto, arrancado por el agente o
 * a mano. Un usuario se quedó atascado ahí (replay de PostHog, 2026-08-29).
 *
 * Pero adoptar A CIEGAS reintroduciría el fallo que motivó ese error: un
 * `http.server` olvidado sirviendo un listado de `/tmp`, tunelado al mundo
 * como si fuera la app del usuario. Por eso se decide por lo que el puerto
 * SIRVE, no por el hecho de que algo escuche.
 */
describe('verdictFor', () => {
  it('adopta una app que sirve HTML', () => {
    expect(
      verdictFor({ contentType: 'text/html; charset=utf-8', bodyStart: '<!doctype html><div id="root">' }),
    ).toEqual({ adopt: true });
  });

  /**
   * ⚠️ EL caso que justificaba fallar, y que hay que seguir rechazando: un
   * `http.server` de Python sirviendo un directorio. Tunelarlo publicaría los
   * ficheros del usuario creyendo que es su app.
   */
  it('RECHAZA un listado de directorios', () => {
    expect(
      verdictFor({
        contentType: 'text/html; charset=utf-8',
        bodyStart: '<!DOCTYPE HTML><html><head><title>Directory listing for /tmp</title>',
      }),
    ).toEqual({ adopt: false, reason: 'directory-listing' });
  });

  it('rechaza también el "Index of" de los otros servidores', () => {
    expect(
      verdictFor({ contentType: 'text/html', bodyStart: '<html><title>Index of /var</title>' }),
    ).toEqual({ adopt: false, reason: 'directory-listing' });
  });

  // Un preview enseña una interfaz. Lo que devuelve JSON en la raíz no es el
  // dev server que se quiere mostrar.
  it('rechaza lo que no es HTML', () => {
    expect(verdictFor({ contentType: 'application/json', bodyStart: '{"ok":true}' })).toEqual({
      adopt: false,
      reason: 'not-html',
    });
    expect(verdictFor({ contentType: undefined, bodyStart: '' })).toEqual({
      adopt: false,
      reason: 'not-html',
    });
  });

  it('si no contesta nadie, no se adopta', () => {
    expect(verdictFor(null)).toEqual({ adopt: false, reason: 'unreachable' });
  });
});

describe('canAdoptPort', () => {
  // Nunca lanza: si la sonda falla por lo que sea, el veredicto es no adoptar
  // — o sea, exactamente el comportamiento que había antes.
  it('una sonda que revienta significa no adoptar, no una excepción', async () => {
    await expect(
      canAdoptPort(3000, () => {
        throw new Error('boom');
      }),
    ).resolves.toEqual({ adopt: false, reason: 'unreachable' });
  });
});

/** Contra servidores REALES: la sonda tiene que leer HTTP de verdad. */
describe('probePort — contra un servidor real', () => {
  const serve = async (
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ) => {
    const s = http.createServer(handler);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    return {
      port: (s.address() as AddressInfo).port,
      close: () => new Promise<void>((r) => s.close(() => r())),
    };
  };

  it('adopta un dev server que sirve la app', async () => {
    const s = await serve((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body><div id="root"></div></body></html>');
    });
    try {
      await expect(canAdoptPort(s.port)).resolves.toEqual({ adopt: true });
    } finally {
      await s.close();
    }
  });

  it('rechaza un listado de directorios real', async () => {
    const s = await serve((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE HTML><html><head><title>Directory listing for /tmp</title></head>');
    });
    try {
      await expect(canAdoptPort(s.port)).resolves.toMatchObject({
        adopt: false,
        reason: 'directory-listing',
      });
    } finally {
      await s.close();
    }
  });

  it('un puerto sin nadie escuchando no se adopta', async () => {
    await expect(canAdoptPort(1)).resolves.toMatchObject({ adopt: false });
  });
});

/**
 * El apagado de un preview ADOPTADO.
 *
 * ⚠️ Adoptar significa que el dev server NO es nuestro. Pararlo mataría el
 * servidor que el usuario tenía corriendo antes de abrir el preview — el daño
 * exacto que la adopción existe para evitar. Por eso `devServer: null` no es
 * un hueco: es la marca de «no lo toques».
 */
describe('killPreview con un preview adoptado', () => {
  it('cierra el túnel pero NO mata el dev server del usuario', async () => {
    const { activePreviews, registerPreview, killPreview } = await import(
      '../../src/services/preview/index'
    );
    const tunnelKill = vi.fn().mockReturnValue(true);
    registerPreview('adoptada', {
      sessionId: 'adoptada',
      devServer: null,
      tunnel: { pid: 2 ** 30, kill: tunnelKill } as never,
      url: 'https://x.test',
      framework: 'Next.js',
      detection: { framework: 'Next.js', command: 'npm', args: [], port: 3000 } as never,
      cwd: process.cwd(),
    });

    // Que no lance ya es la mitad del contrato: el camino viejo hacía
    // `killProcessTree(preview.devServer)` sin guarda.
    await expect(killPreview('adoptada')).resolves.toBeUndefined();
    expect(activePreviews.has('adoptada')).toBe(false);
    expect(tunnelKill).toHaveBeenCalled();
  });
});
