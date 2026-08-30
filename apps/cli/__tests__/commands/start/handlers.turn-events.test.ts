/**
 * El CLI reporta en que fase va un `start_task` — la mitad del embudo que el
 * servidor no puede ver.
 *
 * Con la instrumentacion de entrega ya medida (2026-08-30: el backend entrega
 * 82 de 82 `start_task` y reencola cero), el 43,5% de lanzamientos sin
 * respuesta (codeagent-5iea) NO se pierde en el servidor. Lo que queda son
 * tres casos que desde fuera son el MISMO silencio y tienen arreglos
 * opuestos: el CLI nunca lo vio / lo vio y el turno murio / el turno fue bien
 * y el cliente no lo conto. `phase` es lo unico que los separa.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerContext } from '../../../src/commands/start/handlers';
import type { RemoteCommand } from '../../../src/services/command-relay.service';
import type { CommandRelayService } from '../../../src/services/command-relay.service';
import type { StartCommandPayload } from '../../../src/lib/payload';

vi.mock('../../../src/services/pairing.service', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  postTurnEvent: vi.fn().mockResolvedValue(undefined),
}));

import { handlers } from '../../../src/commands/start/handlers';
import { postTurnEvent } from '../../../src/services/pairing.service';

const postTurnEventMock = vi.mocked(postTurnEvent);

function makeCtx(agentId = 'claude'): HandlerContext {
  const relay = { sendResult: vi.fn().mockResolvedValue(undefined) } as unknown as CommandRelayService;
  return {
    outputSvc: { newTurn: vi.fn() } as unknown as HandlerContext['outputSvc'],
    agent: { sendCommand: vi.fn() } as unknown as HandlerContext['agent'],
    historySvc: {} as HandlerContext['historySvc'],
    relay,
    runtime: {} as HandlerContext['runtime'],
    setKeepAlive: vi.fn(),
    keepAliveCtx: { inCodespace: false } as HandlerContext['keepAliveCtx'],
    pluginId: 'p1',
    sessionId: 'sess-1',
    agentId,
    pluginAuthToken: 'tok',
  } as HandlerContext;
}

const cmd = { id: 'cmd-42' } as RemoteCommand;

function phases() {
  return postTurnEventMock.mock.calls.map((c) => c[0].phase);
}

beforeEach(() => postTurnEventMock.mockClear());

describe('start_task — reporte de fases', () => {
  it('reporta received y luego started en un turno normal', async () => {
    await handlers.start_task(makeCtx(), cmd, { prompt: 'hola' } as StartCommandPayload);
    expect(phases()).toEqual(['received', 'started']);
    expect(postTurnEventMock.mock.calls[0][0]).toMatchObject({
      commandId: 'cmd-42',
      agentId: 'claude',
    });
  });

  it('un prompt VACIO se reporta como fallo, no como silencio', async () => {
    // Antes no arrancaba ningun turno y no lo decia: desde el servidor era
    // identico a un agente colgado.
    await handlers.start_task(makeCtx(), cmd, { prompt: '' } as StartCommandPayload);
    expect(phases()).toEqual(['received', 'failed']);
    expect(postTurnEventMock.mock.calls[1][0].errorCode).toBe('EMPTY_PROMPT');
  });

  it('el rechazo por cambio de agente se reporta con su codigo', async () => {
    await handlers.start_task(makeCtx('claude'), cmd, {
      prompt: 'hola',
      agentId: 'codex',
    } as StartCommandPayload);
    expect(phases()).toEqual(['received', 'failed']);
    expect(postTurnEventMock.mock.calls[1][0].errorCode).toBe('AGENT_SWITCH_UNSUPPORTED');
  });

  it('NUNCA lleva el prompt — esto va a telemetria', async () => {
    await handlers.start_task(makeCtx(), cmd, {
      prompt: 'mi secreto',
    } as StartCommandPayload);
    const sent = JSON.stringify(postTurnEventMock.mock.calls.map((c) => c[0]));
    expect(sent).not.toContain('mi secreto');
  });

  it('sin token de plugin no reporta nada — no revienta el turno', async () => {
    const ctx = makeCtx();
    delete (ctx as { pluginAuthToken?: string }).pluginAuthToken;
    await handlers.start_task(ctx, cmd, { prompt: 'hola' } as StartCommandPayload);
    expect(postTurnEventMock).not.toHaveBeenCalled();
  });
});
