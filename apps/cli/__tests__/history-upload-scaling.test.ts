/**
 * Scale guard for `HistoryService.uploadConversationIfChanged`, the path the
 * ACP `get_conversation` handler uses to keep the backend's canonical
 * conversation fresh so a truncated live render can heal.
 *
 * A conversation can grow to many MB and `get_conversation` is polled (~20 s),
 * so this MUST NOT re-ship the whole transcript on every tick / turn. It has to:
 *   1. upload a full (batched) baseline ONCE,
 *   2. then ship only the DELTA (new messages) — O(new), not O(full),
 *   3. and do nothing at all when the JSONL hasn't changed (mtime-gated).
 *
 * These assertions FAIL against the first-pass fix (which called
 * `loadConversation` — a full re-upload — on every change) and PASS after the
 * baseline-then-delta refinement. Uses a real temp JSONL (real mtime) + spies
 * on the two upload methods, so it stays a pure unit test (no network).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HistoryService } from '../src/services/history.service';
import type { RuntimeStrategy } from '../src/agents/strategy';

let tmpDir: string;

function makeService(): HistoryService {
  const runtime = {
    id: 'claude',
    resolveHistoryDir: () => tmpDir,
  } as unknown as RuntimeStrategy;
  return new HistoryService(runtime, 'plugin-1', '/workspaces/proj');
}

describe('uploadConversationIfChanged — scales to long/heavy conversations', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-hist-scale-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uploads a full baseline ONCE, then only the delta, and skips unchanged polls', async () => {
    const svc = makeService();
    const SID = '54de464c';
    const file = path.join(tmpDir, `${SID}.jsonl`);
    fs.writeFileSync(file, '{"type":"user","message":{}}\n'); // a heavy transcript stand-in

    // Private high-water-mark map — the baseline→delta switch keys off it; the
    // real loadConversation sets it, so the spy mirrors that.
    const internal = svc as unknown as { lastUploadedUuid: Map<string, string> };
    const loadSpy = vi
      .spyOn(svc, 'loadConversation')
      .mockImplementation(async (sid: string) => {
        internal.lastUploadedUuid.set(sid, 'high-water-mark');
      });
    const deltaSpy = vi.spyOn(svc, 'uploadDelta').mockResolvedValue(1);

    // 1) First time the transcript exists → full batched baseline, no delta.
    expect(await svc.uploadConversationIfChanged(SID)).toBe(true);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy).toHaveBeenCalledWith(SID);
    expect(deltaSpy).not.toHaveBeenCalled();

    // 2) ~20s poll, JSONL UNCHANGED (same mtime) → nothing re-shipped at all.
    expect(await svc.uploadConversationIfChanged(SID)).toBe(false);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(deltaSpy).not.toHaveBeenCalled();

    // 3) A new turn grew the file (bump mtime) → ONLY the delta. The full
    //    transcript is NEVER re-shipped — the heavy-conversation guarantee.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(file, future, future);
    expect(await svc.uploadConversationIfChanged(SID)).toBe(true);
    expect(loadSpy).toHaveBeenCalledTimes(1); // still ONCE — no full re-ship
    expect(deltaSpy).toHaveBeenCalledTimes(1);
    expect(deltaSpy).toHaveBeenCalledWith(SID); // pinned to the explicit ACP id
  });
});
