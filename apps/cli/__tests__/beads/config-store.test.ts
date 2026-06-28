import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { beadsConfigPath, readBeadsEnabled, persistBeadsConfig } from '../../src/beads/config-store';

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
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    persistBeadsConfig({ enabled: true });
    expect(readBeadsEnabled()).toBe(true);
  });
});
