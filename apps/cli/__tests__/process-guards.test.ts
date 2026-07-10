import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// Capture the logger so we can assert the crash guards leave a diagnostic
// breadcrumb (they must — a silent death is the exact bug they fix).
const logError = vi.fn();
vi.mock('../src/services/logger', () => ({
  log: {
    error: (...a: unknown[]) => logError(...a),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

import { installRelayCrashGuards } from '../src/lib/process-guards';

// The guard is idempotent (installs exactly once), so we must capture the
// handlers on the very FIRST install — a later spy sees no re-registration.
let onRejection: ((reason: unknown) => void) | undefined;
let onException: ((reason: unknown) => void) | undefined;
let listenerCountAtInstall = 0;

beforeAll(() => {
  const on = vi.spyOn(process, 'on');
  installRelayCrashGuards();
  onRejection = on.mock.calls.find((c) => c[0] === 'unhandledRejection')?.[1] as typeof onRejection;
  onException = on.mock.calls.find((c) => c[0] === 'uncaughtException')?.[1] as typeof onException;
  on.mockRestore();
  listenerCountAtInstall = process.listenerCount('unhandledRejection');
});

describe('installRelayCrashGuards', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logError.mockClear();
    // If the guard ever called process.exit this would flip — it must NOT.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit must not be called by the relay crash guard');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('registers an unhandledRejection handler that logs the stack and does NOT exit', () => {
    expect(onRejection).toBeTypeOf('function');

    onRejection?.(new Error('socket hang up'));

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
    const [tag, msg] = logError.mock.calls[0];
    expect(tag).toBe('process');
    expect(msg).toContain('unhandledRejection');
    // The stack — the breadcrumb that pinpoints the leaking promise — is folded in.
    expect(msg).toContain('socket hang up');
  });

  it('registers an uncaughtException handler that logs and does NOT exit', () => {
    expect(onException).toBeTypeOf('function');

    onException?.(new Error('boom'));

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0][1]).toContain('uncaughtException');
  });

  it('is idempotent — a second install does not re-register listeners', () => {
    installRelayCrashGuards();
    installRelayCrashGuards();
    expect(process.listenerCount('unhandledRejection')).toBe(listenerCountAtInstall);
  });

  it('renders a non-Error rejection reason without throwing', () => {
    onRejection?.({ code: 'ERR', detail: 'HTTP 404 NOT_FOUND' });
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0][1]).toContain('404');
  });
});
