import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { beadsConfigPath, readBeadsEnabled, persistBeadsConfig } from '../../src/beads/config-store';
import { isOwnerOnly } from '../../src/util/restrict-to-owner';

describe('beads config-store', () => {
  const p = beadsConfigPath();
  afterEach(() => { try { fs.rmSync(p); } catch { /* noop */ } });

  it('defaults to enabled when file is absent', () => {
    try { fs.rmSync(p); } catch { /* noop */ }
    expect(readBeadsEnabled()).toBe(true);
  });

  it('round-trips a disabled flag and writes mode 0600', () => {
    persistBeadsConfig({ enabled: false });
    expect(readBeadsEnabled()).toBe(false);
    expect(isOwnerOnly(p)).toBe(true);
    persistBeadsConfig({ enabled: true });
    expect(readBeadsEnabled()).toBe(true);
  });
});
