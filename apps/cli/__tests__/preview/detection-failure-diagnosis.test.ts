import { describe, it, expect } from 'vitest';
import { describeDetectionFailure } from '../../src/services/preview/parser';

/**
 * codeagent-k9q4 — cuando el parseo de la deteccion falla no se registraba la
 * salida CRUDA del agente, asi que era imposible saber POR QUE fallo.
 *
 * El caso que lo pide (rutina nocturna 2026-08-30): haider.mrtatha@gmail.com
 * encadeno 5 `preview_lifecycle: error` en 19 minutos, ninguno
 * `detection_ready`. Cinco intentos, cinco fallos, y se fue. Con lo que hay
 * registrado hoy —`detect: invalid agent output after 4210ms`— no se puede
 * distinguir entre: el agente devolvio prosa, devolvio JSON con un campo de
 * menos, o no devolvio NADA. Son tres arreglos distintos.
 *
 * Y el mensaje al usuario dice "Agent returned invalid JSON" en los tres
 * casos, lo cual es MENTIRA cuando el agente no contesto: manda a mirar un
 * JSON que no existe.
 */
describe('describeDetectionFailure — nombrar el fallo, no solo constatarlo', () => {
  it('sin salida NO dice "JSON invalido" — no hubo JSON que fuera invalido', () => {
    const d = describeDetectionFailure(null)!;
    expect(d.reason).toBe('no_output');
    // La afirmacion FALSA concreta es "devolvio JSON invalido": no hubo nada
    // que fuera invalido. (El nombre del fichero de override lleva "json"
    // legitimamente, asi que se prohibe la acusacion, no la palabra.)
    expect(d.message).not.toMatch(/invalid JSON/i);
  });

  it('con salida vacia lo trata igual que sin salida', () => {
    expect(describeDetectionFailure('   \n  ')!.reason).toBe('no_output');
  });

  it('prosa sin JSON se distingue de JSON malformado', () => {
    expect(describeDetectionFailure('No pude determinar el framework.')!.reason).toBe('no_json');
  });

  it('JSON valido al que le faltan campos es su propio caso', () => {
    // Lo mas traicionero: parsea perfectamente y aun asi no sirve. Antes caia
    // en el mismo saco que la prosa.
    const raw = JSON.stringify({ framework: 'vite', command: 'npm' });
    const d = describeDetectionFailure(raw)!;
    expect(d.reason).toBe('missing_fields');
    expect(d.missing).toEqual(expect.arrayContaining(['args', 'port', 'ready_pattern']));
  });

  it('el mensaje de campos faltantes DICE cuales — es lo unico accionable', () => {
    const raw = JSON.stringify({ framework: 'vite', command: 'npm', args: [], port: 1 });
    expect(describeDetectionFailure(raw)!.message).toMatch(/ready_pattern/);
  });

  it('la salida cruda viaja en el diagnostico, para poder registrarla', () => {
    const d = describeDetectionFailure('No pude determinar el framework.')!;
    expect(d.rawExcerpt).toContain('No pude determinar');
  });

  it('el extracto esta ACOTADO — un agente locuaz no llena el disco', () => {
    // Un one-shot puede devolver miles de lineas. El log de depuracion vive en
    // la maquina del usuario y no es sitio para volcarlas enteras.
    const d = describeDetectionFailure('x'.repeat(50_000))!;
    expect(d.rawExcerpt.length).toBeLessThanOrEqual(1_000);
  });

  it('una deteccion VALIDA no produce diagnostico', () => {
    const raw = JSON.stringify({
      framework: 'vite', command: 'npm', args: ['run', 'dev'],
      port: 5173, ready_pattern: 'Local:',
    });
    expect(describeDetectionFailure(raw)).toBeNull();
  });
});
