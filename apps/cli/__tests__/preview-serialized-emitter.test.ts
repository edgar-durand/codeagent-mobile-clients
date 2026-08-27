import { describe, it, expect, vi } from 'vitest';
import { makeSerializedEmitter } from '../src/services/preview/serialized-emitter';

/**
 * El orden de estos POSTs es load-bearing: un `preview_progress` atendido
 * DESPUÉS del `preview_ready` borraba el snapshot de reconexión recién
 * escrito, y el usuario volvía a la sesión y veía el estado vacío con su
 * preview aún sirviendo.
 */
describe('makeSerializedEmitter', () => {
  it('entrega en orden de emisión aunque el primer POST sea el más lento', async () => {
    const handled: string[] = [];
    const delays: Record<string, number> = { progress: 50, ready: 0 };
    const post = (name: string) =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          handled.push(name);
          resolve();
        }, delays[name] ?? 0),
      );

    const emit = makeSerializedEmitter(post);
    emit('progress'); // lento
    emit('ready'); // rápido — sin la cadena, adelantaría al anterior
    await vi.waitFor(() => expect(handled).toHaveLength(2));

    expect(handled).toEqual(['progress', 'ready']);
  });

  it('un POST fallido no rompe la cadena para los siguientes', async () => {
    const handled: string[] = [];
    const post = (name: string) =>
      name === 'boom' ? Promise.reject(new Error('network')) : Promise.resolve(handled.push(name));

    const emit = makeSerializedEmitter(post);
    emit('boom');
    emit('ready');
    await vi.waitFor(() => expect(handled).toEqual(['ready']));
  });
});
