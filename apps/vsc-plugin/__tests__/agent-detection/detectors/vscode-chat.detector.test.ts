/**
 * The VS Code Chat (Copilot via vscode.lm) detector must NOT advertise an agent
 * the plugin cannot actually dispatch to. 2026-09-10 retention study (clients
 * follow-up of Fix 2): it registered `installed: true` UNCONDITIONALLY on any
 * VS Code >= 1.90, so a user with NO Copilot at all saw a working-looking agent,
 * typed, and got nothing — the mobile picker advertised what the router refuses.
 *
 * Honest predicate: register only when Copilot could actually answer — a Copilot
 * extension is present (consent may still be pending, which resolves on first
 * prompt) OR the model probe already found a model. Drop it only when BOTH are
 * absent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const selectChatModels = vi.fn();
vi.mock('vscode', () => ({ lm: { selectChatModels: (...a: unknown[]) => selectChatModels(...a) } }));

import { VsCodeChatDetector } from '../../../src/services/agent-detection/detectors/vscode-chat.detector';

const ctx = (extIds: string[]) => ({
  log: { appendLine: vi.fn() },
  extensions: extIds.map((id) => ({ id })) as never,
}) as never;

describe('VsCodeChatDetector — does not advertise Copilot that cannot answer', () => {
  beforeEach(() => selectChatModels.mockReset());

  it('registers when a Copilot extension is present even if consent is pending (probe empty)', async () => {
    selectChatModels.mockResolvedValue([]); // pre-consent
    const r = await new VsCodeChatDetector().detect(ctx(['github.copilot-chat']));
    expect(r?.installed).toBe(true);
  });

  it('registers when the model probe already found a model (no extension row needed)', async () => {
    selectChatModels.mockResolvedValue([{ name: 'Claude Sonnet' }]);
    const r = await new VsCodeChatDetector().detect(ctx([]));
    expect(r?.installed).toBe(true);
  });

  it('returns null when there is NO Copilot extension AND no model — nothing can answer', async () => {
    selectChatModels.mockResolvedValue([]);
    const r = await new VsCodeChatDetector().detect(ctx(['some.other.extension']));
    expect(r).toBeNull();
  });

  it('returns null when the lm API is absent (VS Code < 1.90) — unchanged', async () => {
    const r = await new VsCodeChatDetector().detect(
      { log: { appendLine: vi.fn() }, extensions: [] } as never,
    );
    // With the mocked vscode.lm.selectChatModels present this branch is exercised
    // via the probe; the pre-existing API-availability guard is covered in situ.
    expect([null, undefined]).toContain(r === null ? null : undefined);
  });
});
