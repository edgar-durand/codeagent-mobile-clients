/**
 * 2026-09-27 QA codespace: a session daemon orphaned by a host-agent restart
 * looped `write EPIPE` → uncaughtException → log.error → stderr write for ~7 h
 * (1.6 GB of log, no heartbeat). Once stderr is gone the logger must stop
 * writing to it — and keep writing the file.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { log, _logHelpers } from '../src/services/logger';

afterEach(() => {
  vi.restoreAllMocks();
  _logHelpers.resetForTests();
});

function epipe(): NodeJS.ErrnoException {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
}

describe('logger — stderr whose reader is gone', () => {
  it('handles the stream error (it must never become an uncaughtException)', () => {
    expect(process.stderr.listenerCount('error')).toBeGreaterThan(0);
  });

  it('stops writing to stderr after an EPIPE error event', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    log.error('test', 'before');
    expect(write).toHaveBeenCalledTimes(1);

    process.stderr.emit('error', epipe());
    log.error('test', 'after');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('survives a synchronous write throw and stops writing afterwards', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw epipe();
    });
    expect(() => log.error('test', 'one')).not.toThrow();
    log.error('test', 'two');
    expect(write).toHaveBeenCalledTimes(1);
  });
});
