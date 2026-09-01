import { describe, it, expect, vi } from 'vitest';
import {
  bringUpInspector,
  inspectorEnabled,
  resolveInspectorOrigins,
  DEFAULT_INSPECTOR_ORIGINS,
} from '../../src/services/preview/inspector-bringup';

/**
 * ⚠️ Estos tests no comprueban que el inspector funcione. Comprueban que
 * **cuando NO funciona, el preview sigue**.
 *
 * Es la invariante entera del cambio: nos metemos delante del dev server de
 * alguien, así que la pregunta que hay que responder con pruebas no es «¿va el
 * proxy?» sino «¿qué pasa el día que no vaya?». La respuesta tiene que ser
 * «exactamente lo mismo que antes de que existiera».
 */

const okProxy = (port: number) => ({ port, close: async () => undefined });

describe('bringUpInspector — fallo hacia fuera', () => {
  it('devuelve el puerto del proxy cuando arranca', async () => {
    const start = vi.fn().mockResolvedValue(okProxy(45001));
    const out = await bringUpInspector(3000, { start, env: {} });
    expect(out.port).toBe(45001);
    expect(out.proxy).not.toBeNull();
  });

  /** El caso que importa: el túnel vuelve a apuntar al dev server. */
  it('si el proxy no arranca, el túnel va DIRECTO al dev server', async () => {
    const start = vi.fn().mockRejectedValue(new Error('EADDRINUSE'));
    const out = await bringUpInspector(3000, { start, env: {} });
    expect(out.port).toBe(3000);
    expect(out.proxy).toBeNull();
  });

  it('no propaga el error — nada puede tumbar el preview desde aquí', async () => {
    const start = vi.fn().mockRejectedValue(new Error('EMFILE'));
    await expect(bringUpInspector(3000, { start, env: {} })).resolves.toBeDefined();
  });

  it('deja constancia de por qué se fue por el camino directo', async () => {
    const log = vi.fn();
    const start = vi.fn().mockRejectedValue(new Error('EADDRINUSE'));
    await bringUpInspector(3000, { start, log, env: {} });
    expect(log.mock.calls.flat().join(' ')).toContain('EADDRINUSE');
  });

  // El interruptor de emergencia: la salida para un usuario al que el proxy le
  // esté dando guerra, sin esperar a un release.
  it('con CODEAM_PREVIEW_INSPECTOR=0 ni lo intenta', async () => {
    const start = vi.fn();
    const out = await bringUpInspector(3000, {
      start,
      env: { CODEAM_PREVIEW_INSPECTOR: '0' },
    });
    expect(start).not.toHaveBeenCalled();
    expect(out.port).toBe(3000);
    expect(out.proxy).toBeNull();
  });

  it('por defecto está encendido', () => {
    expect(inspectorEnabled({})).toBe(true);
    expect(inspectorEnabled({ CODEAM_PREVIEW_INSPECTOR: '0' })).toBe(false);
    expect(inspectorEnabled({ CODEAM_PREVIEW_INSPECTOR: 'false' })).toBe(false);
    expect(inspectorEnabled({ CODEAM_PREVIEW_INSPECTOR: '1' })).toBe(true);
  });

  // El script inyectado lleva la lista blanca dentro, así que hay que
  // comprobar que llega — sin ella el inspector no obedecería a nadie.
  it('inyecta el script con los orígenes del dashboard', async () => {
    const start = vi.fn().mockResolvedValue(okProxy(1));
    await bringUpInspector(3000, { start, env: {} });
    const script = start.mock.calls[0][0].script as string;
    for (const origin of DEFAULT_INSPECTOR_ORIGINS) {
      expect(script).toContain(origin);
    }
  });
});

describe('resolveInspectorOrigins', () => {
  it('los del producto por defecto', () => {
    expect(resolveInspectorOrigins({})).toEqual(DEFAULT_INSPECTOR_ORIGINS);
  });

  // ⚠️ Los de la env se AÑADEN, no sustituyen. Sustituirlos dejaría que una
  // env mal puesta en una caja apagara la lista blanca de producción entera.
  it('los de la env se añaden a los del producto, no los reemplazan', () => {
    const out = resolveInspectorOrigins({
      CODEAM_INSPECTOR_ORIGINS: 'http://localhost:5173, http://localhost:3001',
    });
    expect(out).toContain('http://localhost:5173');
    expect(out).toContain('http://localhost:3001');
    for (const origin of DEFAULT_INSPECTOR_ORIGINS) expect(out).toContain(origin);
  });
});
