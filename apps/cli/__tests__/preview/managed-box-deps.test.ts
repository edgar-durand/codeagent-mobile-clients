import { describe, it, expect } from 'vitest';
import { isLocalSession } from '../../src/baton/gate';

/**
 * ⚠️ Quién provisiona las dependencias del proyecto (la base de datos en
 * Docker, Redis, las migraciones).
 *
 * El gate era `CODESPACES === 'true'`, y su justificación —«locally the user
 * owns their own services»— es cierta SOLO para el portátil del usuario. En
 * una caja de FLOTA o self-hosted el usuario no tiene nada instalado: esa caja
 * la ponemos nosotros y llega vacía. Un proyecto con Prisma arrancaba ahí sin
 * base de datos, el dev server moría, y el usuario no tenía forma de saber por
 * qué (replay de PostHog, 2026-08-29).
 *
 * Este fichero fija la frontera con el MISMO predicado que usa el batón, para
 * que no se dupliquen y diverjan.
 */
describe('¿es una caja gestionada por nosotros?', () => {
  const managed = (env: NodeJS.ProcessEnv) => !isLocalSession(env);

  it('un codespace lo es', () => {
    expect(managed({ CODESPACES: 'true' })).toBe(true);
  });

  // Una caja de flota o un self-hosted: el host-agent exporta estas. El
  // usuario no instaló ahí un Postgres — lo tenemos que poner nosotros.
  it('una caja de flota / self-hosted lo es', () => {
    expect(managed({ CODEAM_AUTO_APPROVE: '1' })).toBe(true);
    expect(managed({ CODEAM_AUTO_TOKEN: 'x' })).toBe(true);
    expect(managed({ CODEAM_ENROLL_TOKEN: 'x' })).toBe(true);
    expect(managed({ HEADROOM_ENABLED: '1' })).toBe(true);
  });

  /**
   * ⚠️ Y el portátil del usuario NO lo es. Ahí la justificación original sigue
   * intacta: levantar contenedores en la máquina de alguien sin pedírselo
   * sería una intromisión, y además ya tiene sus servicios.
   */
  it('el portátil del usuario NO lo es', () => {
    expect(managed({})).toBe(false);
  });
});
