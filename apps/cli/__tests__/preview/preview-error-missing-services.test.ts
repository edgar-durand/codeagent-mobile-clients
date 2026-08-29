/**
 * Cuando no pudimos servirle la base de datos al proyecto, el error del
 * preview lo DICE — y dice con que variable se arregla.
 *
 * El dato ya existia y se tiraba a la basura: `provisionProjectDependencies`
 * devuelve `{ missing: [{ service, envVar }] }` —sabe que falta Postgres y que
 * `DATABASE_URL` lo resolveria— pero `start.ts` lo consumia con
 * `.catch(() => undefined)` y nadie mas lo veia. El usuario solo veia morir el
 * dev server, sin una sola pista de por que ni de que hacer.
 *
 * ⚠️ El enriquecido se prueba a traves de un handler REAL que emite un error,
 * no llamando a un helper: lo que puede romperse es el cableado del emisor, y
 * un test del helper solo seguiria verde con el emisor desconectado.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPostPreviewEvent } = vi.hoisted(() => ({
  mockPostPreviewEvent: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../src/services/pairing.service', () => ({
  postLinkCredential: vi.fn().mockResolvedValue(undefined),
  postAiResult: vi.fn().mockResolvedValue(undefined),
  postPreviewEvent: mockPostPreviewEvent,
  postHeadroomEvent: vi.fn().mockResolvedValue(undefined),
  postBeadsEvent: vi.fn().mockResolvedValue(undefined),
  postCliUpdateEvent: vi.fn().mockResolvedValue(undefined),
  postCoderabbitEvent: vi.fn().mockResolvedValue(undefined),
  postAgentReviewReport: vi.fn().mockResolvedValue(undefined),
  fetchProvisionCredential: vi.fn().mockResolvedValue(undefined),
}));

import { handlers } from '../../src/commands/start/handlers';
import { noteProvisionOutcome } from '../../src/services/preview';
import type { HandlerContext } from '../../src/commands/start/handlers';
import type { RemoteCommand } from '../../src/services/command-relay.service';

/**
 * Un runtime SIN `generateOneShot` — el camino mas corto a un `preview_error`
 * real (deteccion no soportada), que es todo lo que hace falta para observar
 * al emisor.
 */
function makeCtx(): HandlerContext {
  return {
    outputSvc: {} as HandlerContext['outputSvc'],
    agent: {} as HandlerContext['agent'],
    historySvc: {} as HandlerContext['historySvc'],
    relay: { sendResult: vi.fn().mockResolvedValue(undefined) } as unknown as HandlerContext['relay'],
    runtime: { id: 'claude' } as HandlerContext['runtime'],
    setKeepAlive: vi.fn(),
    keepAliveCtx: { inCodespace: false } as HandlerContext['keepAliveCtx'],
    pluginId: 'plug-1',
    sessionId: 'sess-1',
    agentId: 'claude',
    pluginAuthToken: 'tok-1',
    beads: null,
  } as HandlerContext;
}

const cmd: RemoteCommand = {
  id: 'cmd-1',
  sessionId: 'sess-1',
  type: 'request_preview_detect',
  payload: {},
};

function lastErrorPayload(): Record<string, unknown> {
  const call = mockPostPreviewEvent.mock.calls
    .map((c) => c[0] as { type: string; payload?: Record<string, unknown> })
    .reverse()
    .find((a) => a.type === 'preview_error');
  expect(call, 'se esperaba un preview_error').toBeTruthy();
  return call!.payload ?? {};
}

beforeEach(() => {
  mockPostPreviewEvent.mockClear();
});

describe('preview_error — el fallback de variable de entorno', () => {
  it('lleva los servicios que no pudimos levantar, con su variable', async () => {
    noteProvisionOutcome({
      reason: 'no-docker',
      missing: [{ service: 'postgres', envVar: 'DATABASE_URL' }],
    });

    await handlers.request_preview_detect!(makeCtx(), cmd, {} as never);

    expect(lastErrorPayload().missingServices).toEqual([
      { service: 'postgres', envVar: 'DATABASE_URL' },
    ]);
  });

  it('no adjunta nada cuando las dependencias SI estan servidas', async () => {
    // La otra mitad, y es la que evita mentir: ofrecer una variable de entorno
    // aqui mandaria al usuario a arreglar algo que no esta roto.
    noteProvisionOutcome({ reason: 'ok', missing: [] });

    await handlers.request_preview_detect!(makeCtx(), cmd, {} as never);

    expect(lastErrorPayload().missingServices).toBeUndefined();
  });
});
