import { describe, test, expect, vi, afterEach } from 'vitest';
import { UnixPtyStrategy } from '../../src/services/pty/unix.strategy';

describe('UnixPtyStrategy signal handling', () => {
  afterEach(() => {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  test('SIGINT triggers child.kill(SIGTERM) and exits 130', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const killSpy = vi.fn();
    const strat = new UnixPtyStrategy({ onData: () => {}, onExit: () => {} });
    // Inject a fake child — the field name in the implementation is `proc`.
    Object.assign(strat, { proc: { kill: killSpy, killed: false } });
    strat.installSignalHandlers();

    process.emit('SIGINT');

    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(exitSpy).toHaveBeenCalledWith(130);
    exitSpy.mockRestore();
  });

  test('SIGTERM triggers child.kill(SIGTERM) and exits 143', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const killSpy = vi.fn();
    const strat = new UnixPtyStrategy({ onData: () => {}, onExit: () => {} });
    Object.assign(strat, { proc: { kill: killSpy, killed: false } });
    strat.installSignalHandlers();

    process.emit('SIGTERM');

    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(exitSpy).toHaveBeenCalledWith(143);
    exitSpy.mockRestore();
  });

  test('does not double-kill an already-dead child', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const killSpy = vi.fn();
    const strat = new UnixPtyStrategy({ onData: () => {}, onExit: () => {} });
    Object.assign(strat, { proc: { kill: killSpy, killed: true } });
    strat.installSignalHandlers();

    process.emit('SIGINT');

    expect(killSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(130);
    exitSpy.mockRestore();
  });
});
