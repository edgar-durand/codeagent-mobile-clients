import { describe, it, expect, vi } from 'vitest';
import fixture from '../fixtures/headroom-stats-history.json';
import { toUsageReport, readUsageReport } from '../../src/services/headroom/usage-report';

/**
 * Contract guard for Headroom's `GET /stats-history`.
 *
 * The fixture is a REAL capture from a live proxy (headroom 0.27.0,
 * schema_version 3) — sliced down but field-for-field authentic, including the
 * two things the mapper must strip (`storage_path`, `history[]`). If a future
 * Headroom release moves the schema, these assertions are what fail first.
 */
describe('toUsageReport — trims Headroom /stats-history onto the wire shape', () => {
  it('carries lifetime totals verbatim', () => {
    const r = toUsageReport(fixture);
    expect(r.schemaVersion).toBe(3);
    expect(r.lifetime.tokens_saved).toBe(274096757);
    expect(r.lifetime.requests).toBe(29635);
    expect(r.lifetime.compression_savings_usd).toBeCloseTo(1550.7124, 3);
    expect(r.lifetime.total_input_tokens).toBe(4321853406);
  });

  it('DROPS the raw history[] and the storage_path (size + privacy)', () => {
    const r = toUsageReport(fixture) as unknown as Record<string, unknown>;
    // `history` would double the payload and holds cumulative counters the
    // series already expresses as deltas.
    expect(r.history).toBeUndefined();
    // `storage_path` leaks a local FS path including the OS username.
    expect(r.storage_path).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('/Users/');
  });

  it('keeps all four rollups with per-bucket DELTAS (not just cumulative totals)', () => {
    const r = toUsageReport(fixture);
    expect(Object.keys(r.series).sort()).toEqual(['daily', 'hourly', 'monthly', 'weekly']);
    const daily = r.series.daily!;
    expect(daily.length).toBeGreaterThan(0);
    const last = daily[daily.length - 1];
    // delta ≠ cumulative — the whole reason we chart `tokens_saved`.
    expect(last.tokens_saved).toBeGreaterThan(0);
    expect(last.total_tokens_saved).toBeGreaterThan(last.tokens_saved);
    expect(typeof last.timestamp).toBe('string');
  });

  it('preserves the by_model / by_provider breakdown (richer than the CSV export)', () => {
    const r = toUsageReport(fixture);
    const monthly = r.series.monthly![0];
    expect(Object.keys(monthly.by_model)).toEqual(
      expect.arrayContaining(['claude-opus-4-8', 'claude-sonnet-5']),
    );
    expect(monthly.by_model['claude-opus-4-8'].tokens_saved).toBeGreaterThan(0);
    expect(monthly.by_provider.anthropic.tokens_saved).toBeGreaterThan(0);
  });

  it('carries the current display session + retention policy', () => {
    const r = toUsageReport(fixture);
    expect(r.currentSession).toBeDefined();
    expect(r.retention?.max_history_age_days).toBe(365);
  });

  it('degrades to zeros instead of throwing on an unknown//empty schema', () => {
    expect(() => toUsageReport({})).not.toThrow();
    expect(() => toUsageReport(null)).not.toThrow();
    const r = toUsageReport({ series: { daily: [{ nope: 1 }, null] } });
    expect(r.lifetime.tokens_saved).toBe(0);
    // A bucket with no timestamp is dropped rather than emitted half-built.
    expect(r.series.daily).toBeUndefined();
  });

  it('caps the hourly series so the relay payload stays bounded', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      timestamp: `2026-08-13T${String(i % 24).padStart(2, '0')}:00:00Z`,
      tokens_saved: i,
    }));
    const r = toUsageReport({ series: { hourly: many } });
    expect(r.series.hourly!.length).toBeLessThanOrEqual(48);
    // Keeps the MOST RECENT buckets (proxy returns oldest-first).
    expect(r.series.hourly![r.series.hourly!.length - 1].tokens_saved).toBe(499);
  });
});

describe('readUsageReport', () => {
  it('returns null (never throws) when the proxy is not reachable', async () => {
    const fetchJson = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await readUsageReport({ fetchJson })).toBeNull();
  });

  it('reports the proxy version when /health answers, and survives when it does not', async () => {
    const withHealth = vi.fn(async (p: string) =>
      p === '/health' ? { version: '0.27.0' } : fixture,
    );
    expect((await readUsageReport({ fetchJson: withHealth }))?.proxyVersion).toBe('0.27.0');

    const noHealth = vi.fn(async (p: string) => {
      if (p === '/health') throw new Error('404');
      return fixture;
    });
    const r = await readUsageReport({ fetchJson: noHealth });
    expect(r).not.toBeNull();
    expect(r?.proxyVersion).toBeUndefined();
  });
});
