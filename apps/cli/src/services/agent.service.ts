import { IPtyStrategy } from './pty/types';
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
   * "the agent has rendered its input box and is ready to read
   * keystrokes." Before this, remote `sendCommand`s are buffered
   * (`pendingInputs`) and replayed in order on first data. Without
   * this guard, the very first prompt right after `codeam pair` on
   * Windows lands while the agent's TUI (Claude's React Ink tree,
   * Codex's ratatui mount) is still initialising — the input bytes
   * are accepted by the PTY but never make it to the input field,
   * and the prompt silently vanishes.
   */
  private agentReady = false;
  private readonly pendingInputs: string[] = [];
  /**
   * Serialised-submission state. Without this, a second `sendCommand`
   * arriving while the agent is still rendering its response to the
   * first lands in Claude Code's input field as a `[Pasted text #N]`
   * marker (bracketed-paste mode kicks in for multi-line writes). The
   * `\r` we schedule 50 ms later is consumed as paste content, not
   * submission, so the prompt sits in the input forever — the user
   * reported "se queda bloqueado en la terminal".
   *
   * The fix is agent-agnostic: track when the PTY last emitted bytes
   * (see `lastAgentDataAt`); after `QUIET_MS` of silence we consider
   * the agent idle and drain the next queued prompt. Works for any
   * PTY-spawned runtime (Claude Code, Codex, future agents) because
   * "no output in N ms" is a universal idle signal — we don't depend
   * on Claude's `❯` prompt or Codex's input-box rendering.
   */
  private agentBusy = false;
  private lastAgentDataAt = 0;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * How long the PTY must be silent before we consider the agent
   * idle and submit the next queued prompt. 1500 ms is generous
   * enough that a streamed response with brief mid-token pauses
   * (tool calls, model latency hiccups) doesn't get cut off, but
   * short enough that the user doesn't perceive lag between a
   * normal turn finishing and the next queued comment firing.
   */
  private static readonly QUIET_MS = 1500;
  /**
   * Cached spawn() result so `restart()` can reuse the resolved
   * binary path without re-running the strategy's install path. The
   * agent's installer side-effects (Anthropic curl/iwr, npm install)
   * already happened on initial spawn — we just need to relaunch
   * the SAME binary with new resume args.
   */
  private initialLaunch: {
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    sessionId?: string;
  } | null = null;

  /**
   * Pre-assigned session id from `prepareLaunch` (Claude:
   * `--session-id <uuid>`). When the runtime supports it, the CLI
   * binds the conversation id at spawn time instead of inferring
   * it from filesystem state. Null for runtimes that don't accept
   * a pre-assigned id (Codex, Aider, ...).
   */
  get spawnedSessionId(): string | null {
    return this.initialLaunch?.sessionId ?? null;
  }

  constructor(
    private readonly runtime: RuntimeStrategy,
    private readonly opts: ClaudeServiceOptions,
  ) {
    this.strategyOpts = {
      onData: (d) => {
        if (!this.agentReady && d.length > 0) {
          this.agentReady = true;
          // Wait one tick so the input field finishes mounting before
          // we splat the buffered keystrokes — sending in the same
          // microtask as the data arrival caused React Ink to batch
          // the pending writes with the initial render and lose the
          // first character. 250 ms is conservative and human-
          // imperceptible compared with the multi-second cold start.
          setTimeout(() => this.drainPending(), 250);
        }
        if (d.length > 0) {
          this.lastAgentDataAt = Date.now();
          this.scheduleQuietCheck();
        }
        (opts.onData ?? (() => {}))(d);
      },
      onExit: opts.onExit,
    };
  }

  /**
   * Debounced "agent went idle" check. Re-arms itself as long as
   * fresh PTY output keeps arriving. When the gap since the last
   * byte exceeds `QUIET_MS`, flip `agentBusy=false` and drain the
   * next queued prompt (if any). Idempotent — a no-op when the
   * timer is already pending.
   *
   * Re-arm uses the REMAINING wait (QUIET_MS - sinceLast), not a
   * full QUIET_MS — otherwise a single late data byte resets the
   * waiter to a fresh 1.5 s timer and the queue never drains.
   */
  private scheduleQuietCheck(): void {
    if (this.quietTimer) return;
    const tick = () => {
      this.quietTimer = null;
      const sinceLast = Date.now() - this.lastAgentDataAt;
      if (sinceLast >= AgentService.QUIET_MS) {
        if (this.agentBusy) {
          this.agentBusy = false;
          log.trace('agent', 'agent went idle — draining next pending');
        }
        this.drainPending();
        return;
      }
      // More data came in while waiting — re-arm for the remaining
      // window so we don't reset to a fresh QUIET_MS each time.
      this.quietTimer = setTimeout(tick, AgentService.QUIET_MS - sinceLast);
    };
    this.quietTimer = setTimeout(tick, AgentService.QUIET_MS);
  }

  /**
   * Write one prompt to the PTY and submit it.
   *
   * For multi-line text (or any text > 1 line), Claude Code's TUI
   * triggers bracketed-paste mode and treats the write as a paste:
   * a `[Pasted text #N]` marker lands in the input field, and any
   * `\r` we send while the paste boundary is still open is swallowed
   * as part of the paste content — never reaching the submit
   * handler. The result is the prompt sitting in the input forever
   * (the user reported stacking `[Pasted text #N]` markers with no
   * agent reply).
   *
   * Fix: explicitly bracket the paste ourselves (`ESC[200~ <text>
   * ESC[201~`) so the end marker closes the paste deterministically.
   * A short delay later we send `\r` — now OUTSIDE the bracket — so
   * Claude's input handler treats it as Submit, not paste content.
   * Single-line text doesn't trigger paste mode, so we keep the
   * legacy `text + \r` path for that case (cheaper, no markers).
   *
   * Marks the agent busy so subsequent `sendCommand` calls queue
   * instead of stacking pastes.
   */
  private submitToPty(text: string): void {
    if (!this.strategy) return;
    const s = this.strategy;
    this.agentBusy = true;
    log.trace('agent', `submit text=${text.length}B (queued=${this.pendingInputs.length})`);

    const isMultiline = text.includes('\n');
    if (isMultiline) {
      // Bracketed paste: start marker, content, end marker. Single
      // write so the markers + content land in the same PTY frame
      // (Claude's paste detector needs contiguous bytes).
      s.write(`\x1b[200~${text}\x1b[201~`);
      // Enter follows AFTER the bracketed paste closes — outside the
      // paste boundary it's a regular submit keystroke. The delay is
      // small but non-zero so the TUI has time to commit the paste
      // and place the cursor after it.
      setTimeout(() => s.write('\r'), 80);
    } else {
      s.write(text);
      setTimeout(() => s.write('\r'), 50);
    }
  }

  private drainPending(): void {
    if (!this.strategy || this.pendingInputs.length === 0) return;
    if (this.agentBusy) return;
    const next = this.pendingInputs.shift();
    if (next === undefined) return;
    this.submitToPty(next);
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
    this.initialLaunch = launch;

    // Per-OS PTY backends in priority order. POSIX returns one
    // (UnixPtyStrategy); Win32 returns [ConPTY, pipe-fallback]. We
    // walk the list, attempt .spawn() on each, and fall back on
    // exception. The list is filtered for constructable backends —
    // Win32 may have already dropped ConPTY here if the vendored
    // conpty.node failed to load (AV quarantine, missing prebuild).
    const strategies = this.runtime.os.createPtyStrategies(this.strategyOpts);
    log.trace(
      'agent',
      `spawn ${this.runtime.os.id} cmd=${launch.cmd} args=${launch.args.join(' ')} backends=${strategies.length}`,
    );

    let lastErr: unknown = null;
    for (let i = 0; i < strategies.length; i++) {
      const strategy = strategies[i];
      const isLast = i === strategies.length - 1;
      try {
        strategy.spawn(launch.cmd, this.opts.cwd, launch.args);
        this.strategy = strategy;
        log.trace('agent', `spawn ok via backend ${i + 1}/${strategies.length}`);
        // Dispose any unused later-priority backends so we don't leak
        // file handles / subscriber sockets on those constructors.
        for (let j = i + 1; j < strategies.length; j++) {
          try { strategies[j].dispose(); } catch { /* ignore */ }
        }
        return;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        try { strategy.dispose(); } catch { /* ignore */ }
        if (!isLast) {
          // Surface the fallback so the user understands why TUI
          // quality drops mid-session (e.g. ConPTY → pipe loses
          // selectors). Print to stderr to keep stdout parseable.
          console.error(`\n  ⚠ PTY backend ${i + 1} failed (${msg.split('\n')[0]})`);
          console.error('    Falling back to next backend…\n');
        }
      }
    }

    // Every backend in the priority list failed — there's nothing
    // generic to recover with. Surface the last error verbatim so
    // the user can act on it (often a missing native dep or a bad
    // launch cmd).
    const finalMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(
      `${this.runtime.meta.displayName} PTY launch failed across ${strategies.length} backend(s): ${finalMsg}`,
    );
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
    if (!this.agentReady) {
      // Agent's input field hasn't mounted yet. Buffer; we'll
      // replay the FIRST one in `drainPending()` on first PTY output
      // and the rest will drain as the agent goes idle.
      log.trace('claude', `sendCommand buffered (not ready) text=${text.length}B`);
      this.pendingInputs.push(text);
      return;
    }
    if (this.agentBusy) {
      // A previous prompt is still being processed. Queueing here
      // (rather than blindly writing to the PTY) prevents Claude
      // Code's bracketed-paste mode from converting the second prompt
      // into a `[Pasted text #N]` marker that never submits.
      log.trace('claude', `sendCommand queued (agent busy) text=${text.length}B`);
      this.pendingInputs.push(text);
      return;
    }
    this.submitToPty(text);
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
    if (!this.strategy || !this.initialLaunch) return;
    // Previously this branch hardcoded `buildClaudeLaunch` — for any
    // non-Claude runtime that silently relaunched Claude (or no-op'd
    // on Codex installs). Now we reuse the same binary path the
    // initial spawn resolved + the agent's own resume-args shape.
    //
    // Two args shapes the strategy can produce (encoded in
    // resumeLaunchArgs):
    //   - CLI-flag style (Claude: `--resume <id>` ± bypass)
    //   - subcommand style (Codex: `resume <id>`)
    // Either flows through here unchanged. For agents whose resume
    // is triggered AFTER spawn via a TUI instruction
    // (`postSpawnInstruction`), `resumeLaunchArgs` returns [] and the
    // setTimeout below types the resume command into the PTY.
    const resumeArgs = this.runtime.resumeLaunchArgs(sessionId, { auto });
    this.strategy.kill();
    this.strategy.spawn(this.initialLaunch.cmd, this.opts.cwd, [
      ...this.initialLaunch.args,
      ...resumeArgs,
    ]);
    if (resumeArgs.length === 0 && this.runtime.postSpawnInstruction) {
      const { ptyInput } = this.runtime.postSpawnInstruction(sessionId);
      setTimeout(() => { this.strategy?.write(ptyInput); }, 500);
    }
  }
}
