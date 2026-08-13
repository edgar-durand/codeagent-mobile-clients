import { describe, it, expect } from 'vitest';
import { readUsageReport } from '../../src/services/headroom/usage-report';

/**
 * LIVE contract check against a real Headroom proxy on 127.0.0.1:8787.
 *
 * Env-gated (same convention as the Headroom provisioning + fleet int tests):
 *   RUN_HEADROOM_USAGE_INT=1 npx vitest run headroom-usage.int
 *
 * The unit test pins the mapper against a captured fixture; THIS one is what
 * catches a live Headroom release moving the schema out from under us — run it
 * whenever bumping the proxy version.
 */
const GATED = process.env.RUN_HEADROOM_USAGE_INT === '1';

describe.skipIf(!GATED)('headroom /stats-history — live proxy', () => {
  it('returns a trimmed, privacy-clean report well under the relay budget', async () => {
    const report = await readUsageReport();
    expect(report, 'no proxy on :8787 — start one before running this gate').not.toBeNull();
    if (!report) return;

    // Schema the mapper was written against.
    expect(report.schemaVersion).toBeGreaterThanOrEqual(3);
    expect(typeof report.generatedAt).toBe('string');

    // Size: the raw endpoint is ~150 KB; the trimmed projection must stay small
    // enough to ride the command relay comfortably.
    const kb = Buffer.byteLength(JSON.stringify(report)) / 1024;
    expect(kb).toBeLessThan(64);

    // Privacy: the proxy echoes a local filesystem path; it must never leave.
    const wire = JSON.stringify(report);
    expect(wire).not.toContain('storage_path');
    expect(wire).not.toContain('/Users/');
    expect(wire).not.toContain('/home/');

    // At least one rollup with usable deltas.
    const buckets = Object.values(report.series).flat();
    expect(buckets.length).toBeGreaterThan(0);
    for (const b of buckets) {
      expect(typeof b.timestamp).toBe('string');
      expect(Number.isFinite(b.tokens_saved)).toBe(true);
      expect(Number.isFinite(b.total_tokens_saved)).toBe(true);
    }

    // Lifetime totals are non-negative and coherent.
    expect(report.lifetime.tokens_saved).toBeGreaterThanOrEqual(0);
    expect(report.lifetime.total_input_tokens).toBeGreaterThanOrEqual(
      report.lifetime.tokens_saved,
    );
  });
});
