import { describe, it, expect, vi } from 'vitest';
import {
  makePreviewHeartbeatReaffirm,
  PREVIEW_REAFFIRM_INTERVAL_MS,
} from '../src/services/preview/reaffirm';

/**
 * El backend guarda el estado del preview en Redis con 1 h de TTL, y el CLI
 * solo publicaba en las TRANSICIONES. Así que un preview de más de una hora
 * perdía su snapshot: el usuario refrescaba la página y volvía al estado vacío
 * —"No preview running"— con el dev server perfectamente vivo en el codespace.
 *
 * Misma clase de fallo que tuvo el batón (RUNBOOK: "any TTL'd snapshot whose
 * producer only publishes on transitions"), y se resuelve igual: re-afirmar
 * sobre el heartbeat que YA existe.
 */
const serving = { url: 'https://p.example.com', framework: 'Next.js', port: 3000 };

function harness(opts: { serving: () => typeof serving | null }) {
  const emitReady = vi.fn();
  let clock = 0;
  const rider = makePreviewHeartbeatReaffirm({
    serving: opts.serving,
    emitReady,
    now: () => clock,
  });
  return {
    emitReady,
    beat: (firstAfterConnect = false) => rider({ firstAfterConnect }),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('makePreviewHeartbeatReaffirm', () => {
  it('re-afirma mientras el dev server siga sirviendo', () => {
    const h = harness({ serving: () => serving });
    h.beat();
    expect(h.emitReady).toHaveBeenCalledWith(serving);
  });

  it('NO re-afirma si el dev server murió — la clave debe caducar', () => {
    // Renovar "porque una vez arrancamos un preview" cambiaría un fallo por una
    // mentira más difícil de detectar: la app diría que hay preview cuando no.
    const h = harness({ serving: () => null });
    h.beat();
    h.beat();
    expect(h.emitReady).not.toHaveBeenCalled();
  });

  it('no inunda el bus: una vez por ventana, no en cada beat de 20 s', () => {
    const h = harness({ serving: () => serving });
    h.beat();
    h.advance(20_000);
    h.beat();
    h.advance(20_000);
    h.beat();
    expect(h.emitReady).toHaveBeenCalledTimes(1);

    h.advance(PREVIEW_REAFFIRM_INTERVAL_MS);
    h.beat();
    expect(h.emitReady).toHaveBeenCalledTimes(2);
  });

  it('tras reconectar re-afirma YA, sin esperar la ventana', () => {
    // El backend pudo perder el snapshot mientras estábamos desconectados;
    // esperar la ventana entera dejaría al usuario ante un estado vacío falso
    // durante minutos.
    const h = harness({ serving: () => serving });
    h.beat();
    h.advance(1_000);
    h.beat(true);
    expect(h.emitReady).toHaveBeenCalledTimes(2);
  });

  it('un preview nuevo se afirma de inmediato, sin heredar la ventana del anterior', () => {
    let alive = true;
    const h = harness({ serving: () => (alive ? serving : null) });
    h.beat();
    expect(h.emitReady).toHaveBeenCalledTimes(1);

    alive = false; // se para el preview
    h.advance(1_000);
    h.beat();

    alive = true; // arranca otro enseguida
    h.advance(1_000);
    h.beat();
    expect(h.emitReady).toHaveBeenCalledTimes(2);
  });

  it('la ventana queda muy por debajo del TTL de 1 h de la clave', () => {
    expect(PREVIEW_REAFFIRM_INTERVAL_MS).toBeLessThan(3_600_000 / 4);
  });
});
