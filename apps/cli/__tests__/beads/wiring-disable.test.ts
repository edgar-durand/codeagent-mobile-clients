import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/beads/config-store', () => ({ readBeadsEnabled: vi.fn() }));

import { readBeadsEnabled } from '../../src/beads/config-store';
import { provisionBeadsForStart } from '../../src/beads/wiring';

describe('provisionBeadsForStart disable flag', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CODEAM_BEADS_DISABLED;
    delete process.env.BEADS_DIR;
    delete process.env.BEADS_DOLT_SHARED_SERVER;
  });

  it('no-ops when persisted enabled=false (readBeadsEnabled returns false)', async () => {
    (readBeadsEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const r = await provisionBeadsForStart({
      sessionId: 's',
      pluginId: 'p',
      pluginAuthToken: 't',
      cwd: '/tmp',
      agents: ['claude'],
    });
    expect(r).toBeNull();
  });

  it('does NOT mutate env when persisted enabled=false (true no-op)', async () => {
    (readBeadsEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    delete process.env.BEADS_DIR;
    delete process.env.BEADS_DOLT_SHARED_SERVER;
    await provisionBeadsForStart({
      sessionId: 's',
      pluginId: 'p',
      pluginAuthToken: 't',
      cwd: '/tmp',
    });
    expect(process.env.BEADS_DOLT_SHARED_SERVER).toBeUndefined();
    expect(process.env.BEADS_DIR).toBeUndefined();
  });
});
