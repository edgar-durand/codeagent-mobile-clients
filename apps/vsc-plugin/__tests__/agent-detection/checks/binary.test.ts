import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { whichBinary } from '../../../src/services/agent-detection/checks/binary';

describe('whichBinary', () => {
  let tmpDir: string;
  let originalPath: string | undefined;
  let originalPathext: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whichbin-'));
    originalPath = process.env.PATH;
    originalPathext = process.env.PATHEXT;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalPathext === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = originalPathext;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns the resolved path when binary exists and is executable', async () => {
    const binPath = path.join(tmpDir, 'foo');
    fs.writeFileSync(binPath, '#!/bin/sh\n', { mode: 0o755 });
    process.env.PATH = tmpDir;
    if (process.platform === 'win32') process.env.PATHEXT = '';
    const result = await whichBinary('foo');
    expect(result).toBe(binPath);
  });

  test('returns null when binary is not in PATH', async () => {
    process.env.PATH = tmpDir;
    const result = await whichBinary('does-not-exist-xyz');
    expect(result).toBeNull();
  });

  test('returns null when PATH is empty', async () => {
    process.env.PATH = '';
    expect(await whichBinary('foo')).toBeNull();
  });
});
