import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { quiet, quietAsync, rmIfExistsQuiet, killQuiet } from '../../src/lib/quiet';

function tmpFile(): string {
  return path.join(os.tmpdir(), `quiet-test-${Math.random().toString(36).slice(2)}.tmp`);
}

describe('quiet', () => {
  it('runs the fn and returns undefined', () => {
    const spy = vi.fn();
    expect(quiet(spy)).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('swallows a thrown error', () => {
    expect(() =>
      quiet(() => {
        throw new Error('boom');
      }),
    ).not.toThrow();
  });
});

describe('quietAsync', () => {
  it('awaits a resolved promise', async () => {
    await expect(quietAsync(Promise.resolve(1))).resolves.toBeUndefined();
  });

  it('swallows a rejected promise', async () => {
    await expect(quietAsync(Promise.reject(new Error('nope')))).resolves.toBeUndefined();
  });

  it('accepts a thunk and swallows its rejection', async () => {
    const thunk = vi.fn(async () => {
      throw new Error('thunk boom');
    });
    await expect(quietAsync(thunk)).resolves.toBeUndefined();
    expect(thunk).toHaveBeenCalledTimes(1);
  });
});

describe('rmIfExistsQuiet', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const f of created) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* noop */
      }
    }
    created.length = 0;
  });

  it('removes an existing file', () => {
    const f = tmpFile();
    created.push(f);
    fs.writeFileSync(f, 'x');
    expect(fs.existsSync(f)).toBe(true);
    rmIfExistsQuiet(f);
    expect(fs.existsSync(f)).toBe(false);
  });

  it('is a no-op for a missing file', () => {
    const f = tmpFile();
    expect(() => rmIfExistsQuiet(f)).not.toThrow();
    expect(fs.existsSync(f)).toBe(false);
  });
});

describe('killQuiet', () => {
  it('is a no-op for null / undefined', () => {
    const kill = vi.fn();
    expect(() => killQuiet(null)).not.toThrow();
    expect(() => killQuiet(undefined)).not.toThrow();
    expect(kill).not.toHaveBeenCalled();
  });

  it('calls kill() on a killable with the default SIGTERM', () => {
    const target = { kill: vi.fn() };
    killQuiet(target);
    expect(target.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('passes an explicit signal through', () => {
    const target = { kill: vi.fn() };
    killQuiet(target, 'SIGKILL');
    expect(target.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('swallows an error thrown by kill()', () => {
    const target = {
      kill: vi.fn(() => {
        throw new Error('ESRCH');
      }),
    };
    expect(() => killQuiet(target)).not.toThrow();
  });

  it('signals a numeric pid via process.kill', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killQuiet(123456789, 'SIGKILL');
    expect(spy).toHaveBeenCalledWith(123456789, 'SIGKILL');
    spy.mockRestore();
  });
});
