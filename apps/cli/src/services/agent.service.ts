import { IPtyStrategy } from './pty/types';
import { UnixPtyStrategy } from './pty/unix.strategy';
import { WindowsPtyStrategy } from './pty/windows.strategy';
import { WindowsConPtyStrategy } from './pty/windows-conpty.strategy';
import { buildClaudeLaunch } from './claude-resolver';
import { log } from './logger';
import type { RuntimeStrategy } from '../agents/strategy';

export interface ClaudeServiceOptions {
  cwd: string;
  onData?: (data: string) => void;
  onExit: (code: number) => void;
}

export class AgentService {
  // Strategy is selected lazily inside spawn() so we can fall back from
  // ConPTY → legacy pipe at runtime if the native binding fails to load.
  // Methods called before spawn() (e.g. early kill/SIGINT) no-op safely.
  private strategy: IPtyStrategy | null = null;
  private readonly strategyOpts: { onData: (d: string) => void; onExit: (c: number) => void };
  /**
   * Set once the PTY emits its FIRST batch of output — proxy for
   * "Claude has rendered its input box and is ready to read keystrokes."
   * Before this, remote `sendCommand`s are buffered (`pendingInputs`)
   * and replayed in order on first data. Without this guard, the very
   * first prompt right after `codeam pair` on Windows lands while
   * Claude's React Ink tree is still mounting — the input bytes are
   * accepted by the PTY but never make it to the input field, and
   * the prompt silently vanishes.
   */
  private claudeReady = false;
  private readonly pendingInputs: string[] = [];

  constructor(
    private readonly runtime: RuntimeStrategy,
    private readonly opts: ClaudeServiceOptions,
  ) {
    this.strategyOpts = {
      onData: (d) => {
        if (!this.claudeReady && d.length > 0) {
          this.claudeReady = true;
          // Wait one tick so the input field finishes mounting before
          // we splat the buffered keystrokes — sending in the same
          // microtask as the data arrival caused React Ink to batch
          // the pending writes with the initial render and lose the
          // first character. 250 ms is conservative and human-
          // imperceptible compared with the multi-second cold start.
          setTimeout(() => this.drainPending(), 250);
        }
        (opts.onData ?? (() => {}))(d);
      },
      onExit: opts.onExit,
    };
  }

  private drainPending(): void {
    if (!this.strategy || this.pendingInputs.length === 0) return;
    const s = this.strategy;
    log.trace('claude', `drain pending=${this.pendingInputs.length}`);
    // Each buffered input replays the original sendCommand pacing
    // (text → 50 ms → \r) so React Ink has a fresh tick to absorb the
    // text into input state before the submit fires.
    let offset = 0;
    for (const text of this.pendingInputs) {
      setTimeout(() => s.write(text), offset);
      setTimeout(() => s.write('\r'), offset + 50);
      offset += 200;
    }
    this.pendingInputs.length = 0;
  }

  async spawn(): Promise<void> {
    // Each RuntimeStrategy owns its own resolve-or-install flow inside
    // prepareLaunch(): Claude runs Anthropic's official installer when
    // the binary is missing, Codex runs `npm install -g @openai/codex`,
    // and any future agent will follow the same contract. By the time
    // a strategy throws here, it has already exhausted its install
    // path — there is nothing generic this layer can do beyond
    // surfacing the agent-specific error to the user and exiting.
    let launch: { cmd: string; args: string[]; env?: Record<string, string> };
    try {
      launch = await this.runtime.prepareLaunch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `\n  ✗ ${this.runtime.meta.displayName} could not be launched.\n    ${msg}\n`,
      );
      process.exit(1);
    }

    if (process.platform === 'win32') {
      // Prefer ConPTY (real terminal) so Claude doesn't fall into its
      // "--print + 3s stdin wait" non-interactive path. The vendored
      // node-pty bundle (see scripts/vendor-node-pty.js) ships the
      // prebuilt conpty.node so this load is deterministic. Two
      // failure modes still possible:
      //
      //   1. require throws because the vendored bundle is corrupt or
      //      missing (e.g. AV quarantined the .node file). tryCreate
      //      returns null → pipe fallback.
      //   2. require succeeds but lib.spawn() throws — typically a
      //      mis-resolved cmd (e.g. a `.cmd` shim handed to ConPTY
      //      without a cmd.exe wrapper). Caught here → pipe fallback.
      log.trace('claude', `spawn (win32) cmd=${launch.cmd} args=${launch.args.join(' ')}`);
      const conpty = WindowsConPtyStrategy.tryCreate(this.strategyOpts);
      if (conpty) {
        try {
          conpty.spawn(launch.cmd, this.opts.cwd, launch.args);
          this.strategy = conpty;
          log.trace('claude', 'ConPTY spawn ok');
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Best-effort cleanup of half-initialized state.
          try { conpty.dispose(); } catch { /* ignore */ }
          console.error(`\n  ⚠ ConPTY launch failed (${msg.split('\n')[0]})`);
          console.error('    Falling back to pipe mode (limited interactivity)…\n');
        }
      } else {
        console.error(
          '\n  ⚠ Windows: node-pty unavailable, falling back to pipe mode.\n' +
            '    Claude may exit with "no stdin data" / "--print" errors.\n' +
            '    Reinstall the CLI to fetch the prebuilt ConPTY binary, or run inside WSL.\n',
        );
      }
      const pipe = new WindowsPtyStrategy(this.strategyOpts);
      pipe.spawn(launch.cmd, this.opts.cwd, launch.args);
      this.strategy = pipe;
      return;
    }

    const unix = new UnixPtyStrategy(this.strategyOpts);
    unix.spawn(launch.cmd, this.opts.cwd, launch.args);
    this.strategy = unix;
  }

  /**
   * Send a command to Claude's stdin (remote control from mobile).
   *
   * Why two separate writes with a delay?
   * Same batching problem as selectOption: all bytes arriving in one write()
   * call are processed by readline in one synchronous run.  React Ink batches
   * the resulting state updates, so when '\r' fires the input's value is still
   * the pre-batch (empty/previous) state → Enter submits nothing and the text
   * stays visible-but-unsubmitted in the input field.
   *
   * Sending '\r' in a separate write() ~50 ms later guarantees it arrives on
   * a fresh event-loop tick, after React has flushed the text into input state.
   *
   * The delay scales with line count: Smart Composer outputs are ~500–1500
   * chars with embedded `\n`s (Task / Context / Steps blocks). Ink's input
   * field re-flows multi-line content per render and the 50 ms baseline that
   * worked for single-line prompts isn't enough headroom — the text lands in
   * the field but `\r` submits stale state and the prompt sits there until
   * the user hits Enter manually. Adding ~40 ms per extra line (capped at
   * 300 ms) keeps short prompts snappy while giving multi-line composer
   * outputs the time they need to settle.
   */
  sendCommand(text: string): void {
    if (!this.strategy) {
      log.trace('claude', 'sendCommand dropped (no strategy)');
      return;
    }
    if (!this.claudeReady) {
      // Claude's input field hasn't mounted yet. Buffer; we'll
      // replay this in `drainPending()` on first PTY output.
      log.trace('claude', `sendCommand buffered (not ready) text=${text.length}B`);
      this.pendingInputs.push(text);
      return;
    }
    const s = this.strategy;
    log.trace('claude', `sendCommand text=${text.length}B`);
    s.write(text);
    const lineCount = text.split('\n').length;
    const delay = Math.min(300, 50 + (lineCount - 1) * 40);
    setTimeout(() => s.write('\r'), delay);
  }

  /**
   * Navigate a React Ink selector to the given 0-based target index and confirm.
   *
   * `fromIndex` is the current highlighted position (defaults to 0 for
   * numbered selectors which always start at the first option). For list-style
   * selectors (e.g. /mcp), the CLI sends `currentIndex` in the select_prompt
   * chunk so the client can pass it back here as `fromIndex`, enabling both
   * up-arrow and down-arrow navigation without always rewinding to position 0.
   *
   * Why not sendCommand(arrows + Enter) in one write()?
   * All bytes arrive as one chunk → readline fires all keypress events in the
   * same synchronous run → React Ink batches the state updates → each arrow
   * sees selectedIndex=0 → final state is still 0 or 1 → wrong option selected.
   *
   * Fix: send each arrow in a separate write(), ARROW_MS apart, so React has
   * time to process and re-render between each keystroke.  Enter is sent
   * ENTER_MS after the last arrow.
   */
  selectOption(targetIndex: number, fromIndex = 0): void {
    if (!this.strategy) return;
    const s = this.strategy;
    const delta = targetIndex - fromIndex;
    const steps = Math.abs(delta);
    const arrow  = delta >= 0 ? '\x1B[B' : '\x1B[A'; // ↓ or ↑

    const ARROW_MS = 80;
    const ENTER_MS = 200;

    if (steps === 0) {
      s.write('\r');
      return;
    }

    for (let i = 0; i < steps; i++) {
      setTimeout(() => { s.write(arrow); }, i * ARROW_MS);
    }
    setTimeout(() => {
      s.write('\r');
    }, steps * ARROW_MS + ENTER_MS);
  }

  /**
   * Write raw bytes to the PTY without any auto-appended `\r` or delay.
   * Use this when the caller already owns the full input (e.g. the
   * `ptyInput` returned by `RuntimeStrategy.changeModelInstruction()`
   * already contains the trailing `\r`).
   */
  sendRawPtyInput(text: string): void {
    if (!this.strategy) {
      log.trace('claude', 'sendRawPtyInput dropped (no strategy)');
      return;
    }
    log.trace('claude', `sendRawPtyInput len=${text.length}`);
    this.strategy.write(text);
  }

  /** Send Escape key to Claude (cancels interactive prompts). */
  sendEscape(): void {
    this.strategy?.write('\x1b');
  }

  /** Send Ctrl+C to Claude. */
  interrupt(): void {
    this.strategy?.write('\x03');
  }

  kill(): void {
    this.strategy?.kill();
  }

  /**
   * Kill the current Claude process and relaunch it resuming the given session.
   * Pass auto=true to add --dangerously-skip-permissions (no confirmation prompts).
   *
   * For agents that use CLI flags (Claude: --resume <id>), `resumeLaunchArgs`
   * returns a non-empty array and we pass those directly to the binary.
   * For agents that use a post-spawn PTY instruction (e.g. Codex), `resumeLaunchArgs`
   * returns [] and `postSpawnInstruction` types the resume command into the PTY.
   */
  restart(sessionId: string, auto = false): void {
    if (!this.strategy) return;
    // Source resume args from the runtime strategy so agent-specific flag
    // conventions (Claude: --resume + --dangerously-skip-permissions) live
    // in one place. When auto=false we only need --resume without the
    // permissions bypass, so we fall back to a simple base array.
    const resumeArgs = auto
      ? this.runtime.resumeLaunchArgs(sessionId)
      : ['--resume', sessionId];
    const launch = buildClaudeLaunch(resumeArgs);
    if (!launch) return;
    this.strategy.kill();
    this.strategy.spawn(launch.cmd, this.opts.cwd, launch.args);
    // For agents whose resume is triggered by a PTY instruction rather than
    // a CLI flag (resumeArgs.length === 0), send the instruction once the
    // PTY is ready. Claude always uses flags so this branch is a no-op for now.
    if (resumeArgs.length === 0 && this.runtime.postSpawnInstruction) {
      const { ptyInput } = this.runtime.postSpawnInstruction(sessionId);
      setTimeout(() => { this.strategy?.write(ptyInput); }, 500);
    }
  }
}
