import { describe, it, expect } from 'vitest';
import { toRemoteCommand } from '../src/protocol/remote-command';

const validEnvelope = {
  id: 'cmd-1',
  sessionId: 'sess-1',
  pluginId: 'plug-1',
  type: 'send_prompt',
  payload: { prompt: 'hello' },
  status: 'pending',
  createdAt: 1_700_000_000_000,
};

describe('toRemoteCommand', () => {
  it('accepts a fully-populated envelope verbatim', () => {
    const cmd = toRemoteCommand(validEnvelope);
    expect(cmd).toEqual(validEnvelope);
  });

  it('normalizes a missing payload to {}', () => {
    const { payload: _payload, ...withoutPayload } = validEnvelope;
    const cmd = toRemoteCommand(withoutPayload);
    expect(cmd).not.toBeNull();
    expect(cmd?.payload).toEqual({});
  });

  it('normalizes a null payload to {}', () => {
    const cmd = toRemoteCommand({ ...validEnvelope, payload: null });
    expect(cmd).not.toBeNull();
    expect(cmd?.payload).toEqual({});
  });

  it('returns null when a required string field is missing', () => {
    const { id: _id, ...withoutId } = validEnvelope;
    expect(toRemoteCommand(withoutId)).toBeNull();
  });

  it('returns null when a field has the wrong type', () => {
    expect(toRemoteCommand({ ...validEnvelope, createdAt: 'yesterday' })).toBeNull();
    expect(toRemoteCommand({ ...validEnvelope, type: 42 })).toBeNull();
    expect(toRemoteCommand({ ...validEnvelope, payload: 'not-an-object' })).toBeNull();
  });

  it('returns null (never throws) on non-object inputs', () => {
    expect(toRemoteCommand(null)).toBeNull();
    expect(toRemoteCommand(undefined)).toBeNull();
    expect(toRemoteCommand('a string')).toBeNull();
    expect(toRemoteCommand(123)).toBeNull();
    expect(toRemoteCommand([validEnvelope])).toBeNull();
  });
});
