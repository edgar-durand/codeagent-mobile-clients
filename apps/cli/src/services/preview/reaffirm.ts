import { log } from '../logger';

/**
 * Mantiene viva la clave del snapshot del preview MIENTRAS el dev server lo
 * esté.
 *
 * El backend guarda el estado del preview en Redis `preview:<sessionId>` con
 * **1 h de TTL**, y el CLI solo publicaba en las TRANSICIONES. Así que un
 * preview que llevara más de una hora corriendo perdía su snapshot: el usuario
 * refrescaba la página y volvía al estado vacío —"No preview running"— con el
 * dev server perfectamente vivo en el codespace, y tenía que arrancarlo otra
 * vez a mano.
 *
 * Es exactamente la misma clase de fallo que tuvo el batón (RUNBOOK: "any
 * TTL'd snapshot whose producer only publishes on transitions"), y se resuelve
 * igual: re-afirmar el estado sobre el heartbeat que YA existe.
 *
 * ⚠️ **La re-afirmación se gatea en el proceso REAL, no en un recuerdo.**
 * `isServing()` mira si el dev server sigue vivo; si murió, no se re-afirma,
 * la clave caduca sola y el usuario ve el estado vacío — que entonces es la
 * verdad. Renovar la clave "porque una vez arrancamos un preview" sería
 * cambiar un fallo por una mentira más difícil de detectar.
 *
 * ⚠️ **Ni un temporizador nuevo.** Viaja como pasajero del tick de 20 s del
 * relay, igual que `makeBatonHeartbeatReaffirm` — el proyecto prohíbe añadir
 * bucles de sondeo, y de todos modos aquí no hay nada que sondear: el estado
 * se conoce en el proceso.
 */

/**
 * Cada cuánto se re-afirma. Muy por debajo del TTL de 1 h para que la clave se
 * refresque con un margen amplísimo, y mucho más espaciado que el heartbeat de
 * 20 s sobre el que viaja para no inundar el bus SSE. Mismo número que el
 * batón, por la misma razón.
 */
export const PREVIEW_REAFFIRM_INTERVAL_MS = 5 * 60_000;

export interface PreviewReaffirmDeps {
  /**
   * ¿Hay un preview REALMENTE sirviendo ahora mismo? Devuelve sus datos, o
   * `null` si no hay ninguno o su proceso ya murió.
   */
  serving: () => { url: string; framework: string; port: number } | null;
  /** Re-emite `preview_ready`. Debe ir por el MISMO emisor serializado que las
   *  transiciones, para que una re-afirmación no adelante a un evento real. */
  emitReady: (payload: { url: string; framework: string; port: number }) => void;
  /**
   * Publishes `preview_stopped` once, on the FIRST beat of this process, when
   * nothing is serving. The backend keeps `preview:<sessionId>` for an hour, so
   * a preview that died WITH its machine (a codespace stop, a Box restart)
   * read "RUNNING FOR 35 MIN" with a QR to a dead tunnel (QA, 2026-09-26)
   * until the key expired. The implementation must no-op once a preview was
   * requested in this process, so a start in flight is never cut short.
   */
  clearStale?: () => void;
  intervalMs?: number;
  now?: () => number;
}

export function makePreviewHeartbeatReaffirm(
  deps: PreviewReaffirmDeps,
): (info: { firstAfterConnect: boolean }) => void {
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? PREVIEW_REAFFIRM_INTERVAL_MS;
  let lastAffirmedAt: number | null = null;
  let firstBeat = true;

  return ({ firstAfterConnect }): void => {
    const current = deps.serving();
    const isFirstBeat = firstBeat;
    firstBeat = false;
    if (!current && isFirstBeat) deps.clearStale?.();
    if (!current) {
      // Sin preview vivo no hay nada que afirmar — y el reloj se reinicia para
      // que el PRÓXIMO preview se afirme de inmediato en vez de heredar la
      // ventana del anterior.
      lastAffirmedAt = null;
      return;
    }
    const at = now();
    // Tras una reconexión se re-afirma ya: el backend pudo perder el snapshot
    // mientras estábamos desconectados, y esperar la ventana entera dejaría al
    // usuario ante un estado vacío falso durante minutos.
    if (!firstAfterConnect && lastAffirmedAt !== null && at - lastAffirmedAt < intervalMs) return;
    lastAffirmedAt = at;
    log.trace('preview', `reaffirm: preview sigue sirviendo en ${current.url}`);
    deps.emitReady(current);
  };
}
