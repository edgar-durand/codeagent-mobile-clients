import { describe, it, expect, vi } from 'vitest';
import {
  createWakeCredentialProbe,
  localCredentialExpiryStatus,
} from '../../src/agents/acp/wakeCredentialProbe';

describe('createWakeCredentialProbe', () => {
  it('surfaces re-auth + flags the credential when the local token is expired', async () => {
    const emitReauthBubble = vi.fn().mockResolvedValue(undefined);
    const reportCredentialInvalid = vi.fn().mockResolvedValue(undefined);
    const probe = createWakeCredentialProbe({
      getStatus: () => 'expired',
      emitReauthBubble,
      reportCredentialInvalid,
    });

    const flagged = await probe.run();

    expect(flagged).toBe(true);
    expect(emitReauthBubble).toHaveBeenCalledTimes(1);
    expect(reportCredentialInvalid).toHaveBeenCalledTimes(1);
  });

  it.each(['valid', 'unknown'] as const)(
    'does nothing (no bubble, no flag) when status is %s',
    async (status) => {
      const emitReauthBubble = vi.fn();
      const reportCredentialInvalid = vi.fn();
      const probe = createWakeCredentialProbe({
        getStatus: () => status,
        emitReauthBubble,
        reportCredentialInvalid,
      });

      const flagged = await probe.run();

      expect(flagged).toBe(false);
      expect(emitReauthBubble).not.toHaveBeenCalled();
      expect(reportCredentialInvalid).not.toHaveBeenCalled();
    },
  );

  it('never throws if the status read fails (probe must not block the session)', async () => {
    const probe = createWakeCredentialProbe({
      getStatus: () => {
        throw new Error('cred read blew up');
      },
      emitReauthBubble: vi.fn(),
      reportCredentialInvalid: vi.fn(),
    });

    await expect(probe.run()).resolves.toBe(false);
  });

  it('still resolves true when emit throws — the flag/report is best-effort', async () => {
    const reportCredentialInvalid = vi.fn().mockResolvedValue(undefined);
    const probe = createWakeCredentialProbe({
      getStatus: () => 'expired',
      emitReauthBubble: vi.fn().mockRejectedValue(new Error('publish failed')),
      reportCredentialInvalid,
    });

    await expect(probe.run()).resolves.toBe(true);
    expect(reportCredentialInvalid).toHaveBeenCalledTimes(1);
  });
});

describe('localCredentialExpiryStatus', () => {
  it('returns "unknown" for non-Claude agents (never a false trigger)', async () => {
    expect(await localCredentialExpiryStatus('codex')).toBe('unknown');
    expect(await localCredentialExpiryStatus('gemini')).toBe('unknown');
    expect(await localCredentialExpiryStatus('cursor')).toBe('unknown');
  });
});
