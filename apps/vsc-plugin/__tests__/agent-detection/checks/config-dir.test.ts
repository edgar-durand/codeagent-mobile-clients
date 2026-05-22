import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dirExists, expandHome } from '../../../src/services/agent-detection/checks/config-dir';

describe('expandHome', () => {
  test('expands a leading ~ to the user home', () => {
    expect(expandHome('~/.codex')).toBe(path.join(os.homedir(), '.codex'));
  });

  test('leaves non-tilde paths untouched', () => {
    expect(expandHome('/etc/codex')).toBe('/etc/codex');
  });
});

describe('dirExists', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns true when the directory exists', async () => {
    expect(await dirExists(tmpDir)).toBe(true);
  });

  test('returns false when the path does not exist', async () => {
    expect(await dirExists(path.join(tmpDir, 'missing'))).toBe(false);
  });

  test('returns false when the path is a file, not a directory', async () => {
    const filePath = path.join(tmpDir, 'a-file');
    fs.writeFileSync(filePath, 'x');
    expect(await dirExists(filePath)).toBe(false);
  });
});
