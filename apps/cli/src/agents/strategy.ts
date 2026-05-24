import type { ChildProcess } from 'node:child_process';
import type { AgentId, AgentMetadata, AgentModel, ChromeStep, NormalizedMessage, SelectPrompt } from '@codeagent/shared';
import type { OsStrategy } from '../os';
import type { CloudProvider } from '../services/providers/types';

export interface ChangeModelInstruction {
  type: 'pty' | 'restart';
  ptyInput?: string;
  restartArgs?: string[];
}

/**
 * Local credential blob captured by `codeam link <agent>` and shipped
 * to the backend vault. Hoisted here from `agents/claude/local-token.ts`
 * so both per-agent link strategies + the link command share one type.
 */
export interface LocalAgentToken {
  /** OAuth bundle from `<agent> login`, or a raw API key when the
   *  user explicitly passed --api-key. */
  method: 'oauth' | 'api_key';
  /** Opaque token string — the backend stores it verbatim. */
  credential: string;
  /** Where we found it — drives the user-facing success message. */
  source: 'flat-file' | 'macos-keychain' | 'manual';
}

/**
 * Per-agent credential probe used by `codeam link <agent>`. The link
 * command watches `watchPaths()` for fresh writes + polls
 * `extract()` whenever the agent's sign-in subprocess writes
 * something (file or macOS Keychain). `publicId` is the backend-
 * facing identifier for `/api/plugin/agents/<publicId>/link` — it
 * differs from the internal `AgentId` because the backend uses
 * `claude_code` (snake_case) for legacy compatibility.
 */
export interface AgentCredentialLocator {
  readonly publicId: string;
  readonly vendor: string;
  readonly hint: string;
  watchPaths(): string[];
  extract(): Promise<LocalAgentToken | null>;
}

/**
 * Per-agent sign-in flow launcher. `ensureInstalled` guarantees the
 * agent's own binary is on PATH before `launch()` (auto-installing
 * when the agent ships an installer; surfacing a clear error
 * otherwise). `launch()` spawns the foreground subprocess that the
 * user completes in their browser — the link command runs it in
 * parallel with chokidar+Keychain probes and kills it as soon as
 * a credential is captured.
 */
export interface AgentLoginLauncher {
  ensureInstalled(): Promise<boolean>;
  launch(): ChildProcess;
}

// ─── Base agent strategy (shared by Interactive + Batch) ─────────────

/**
 * Fields every agent strategy carries regardless of invocation mode.
 * Subdivides into:
 *
 *   - `InteractiveAgentStrategy` (Claude, Codex, Cursor, Aider): the
 *     agent runs as a long-lived PTY-wrapped REPL. The CLI surfaces
 *     its TUI to the mobile / web client, intercepts selectors,
 *     drives slash commands.
 *   - `BatchAgentStrategy` (CodeRabbit and any other one-shot agent):
 *     the agent is invoked once, prints structured output, exits.
 *     No PTY, no TUI parsing, no live streaming — the CLI surfaces
 *     the run's outcome (markdown report, file annotations) to the
 *     mobile feed after the process completes.
 *
 * Both kinds share id + meta + os + credential locator + login
 * launcher; downstream consumers branch on `mode` to route to the
 * right code path.
 */
export interface BaseAgentStrategy {
  readonly id: AgentId;
  readonly meta: AgentMetadata;
  /**
   * Per-OS primitives the strategy composes for spawn / PATH /
   * shell-escape / temp-file work. Each platform impl (darwin,
   * linux, win32) is interchangeable; no concrete strategy should
   * branch on `process.platform` — it should ask `this.os` instead.
   */
  readonly os: OsStrategy;
  /**
   * Discriminator for type narrowing at consumer call sites.
   * `interactive` ⇒ shape matches `InteractiveAgentStrategy`;
   * `batch` ⇒ shape matches `BatchAgentStrategy`.
   */
  readonly mode: 'interactive' | 'batch';

  /**
   * Credential locator for `codeam link <agent>`. Returns the
   * per-agent probe (file watch paths + extract()). Tests can
   * subclass and override.
   */
  credentialLocator(): AgentCredentialLocator;

  /**
   * Sign-in subprocess launcher for `codeam link <agent>`. Returns
   * the per-agent ensureInstalled() + launch() pair.
   */
  loginLauncher(): AgentLoginLauncher;
}

// ─── Interactive agents (PTY REPL) ───────────────────────────────────

export interface InteractiveAgentStrategy extends BaseAgentStrategy {
  readonly mode: 'interactive';

  prepareLaunch(): Promise<{ cmd: string; args: string[]; env?: Record<string, string> }>;
  /**
   * Args to splice in for a "resume previous session" relaunch. Two
   * shapes in the wild:
   *   - Claude: `--resume <id>` CLI flag, optionally with the
   *     `--dangerously-skip-permissions` bypass for auto-restarts
   *     (background reconnect — we already had the user's consent).
   *   - Codex: `resume <id>` subcommand (no bypass equivalent).
   *
   * `opts.auto` distinguishes user-initiated relaunches (false) from
   * background reconnects (true). Agents that don't differentiate
   * (Codex) ignore the option.
   */
  resumeLaunchArgs(sessionId: string, opts?: { auto?: boolean }): string[];
  postSpawnInstruction?(sessionId: string): { ptyInput: string };

  resolveHistoryDir(cwd: string): string | null;
  parseHistoryFile(filePath: string): NormalizedMessage[];
  getCurrentUsage(historyDir: string): { used: number; total: number; percent: number; model?: string } | null;

  fetchWeeklyUsage(): Promise<{ percent: number; resetAt?: string } | null>;

  listModels(): Promise<AgentModel[]>;
  changeModelInstruction(modelId: string): ChangeModelInstruction;
  summarizeInstruction(mode: 'normal' | 'auto'): { ptyInput: string };

  /**
   * Per-agent chrome detection. Returns a ChromeStep for "thinking" /
   * tool-call lines that the relay should render as progress instead of
   * conversation, or null for lines that are either user/agent text or
   * pure noise (those route through filterTuiOutput).
   *
   * Optional: agents that don't surface tool-call chrome (e.g. Codex
   * Phase 2 baseline) leave this undefined and the ChromeStepTracker
   * falls back to a no-op.
   */
  parseTuiChrome?(line: string): ChromeStep | null;

  /**
   * Per-agent virtual-terminal renderer. Turns the raw PTY byte buffer
   * into the visible-screen line array that filterTuiOutput consumes.
   *
   * Optional: agents that work fine with the shared baseline renderer
   * (Claude — its React Ink TUI doesn't touch scroll regions or alt
   * screen toggles) leave this undefined and OutputService falls back
   * to the shared `renderToLines`. Codex needs its own because the
   * Codex CLI uses DECSTBM scroll regions + Reverse Index (ESC M) to
   * scroll chat history within a top zone — those bytes get dropped by
   * the shared renderer and the mobile feed sees only the first
   * paragraph of multi-line agent replies.
   */
  renderToLines?(buffer: string): string[];

  /**
   * Per-agent chrome stripper. Returns only the lines that should
   * appear in the mobile chat feed (agent replies + user-visible text).
   * Drops spinners, tool-call bullets, status frames, user echoes,
   * and (for Codex) intro box drawings + Tip/Learn-more banners.
   */
  filterTuiOutput(lines: string[]): string[];

  /**
   * Per-agent interactive-prompt detector. Returns the selector when
   * the agent is showing a multi-choice menu, null otherwise.
   */
  detectInteractivePrompt(lines: string[]): SelectPrompt | null;
}

// ─── Batch agents (one-shot CLI tools — CodeRabbit, etc.) ───────────

/**
 * Input shape for a single batch-agent invocation. Subset of fields
 * the agent's `prepareInvocation` consumes; concrete agents pick the
 * ones that make sense for their CLI surface (PR review needs `prMode`,
 * a file-only reviewer needs `files`, …).
 */
export interface BatchInvocationInput {
  /** Free-form prompt / instruction passed via the agent's input flag
   *  (e.g. `coderabbit review --message "$prompt"`). */
  prompt?: string;
  /** GitHub PR ref the agent should review (e.g. "123" or full URL). */
  prRef?: string;
  /** Working-tree-relative paths the agent should focus on. */
  files?: string[];
  /** Additional raw args appended verbatim — escape hatch for power
   *  users. The runtime is responsible for shell-escaping these via
   *  `os.escapeShellArg` if the agent's launcher takes a shell string. */
  extraArgs?: string[];
}

/**
 * Structured result the runtime returns to the caller after a batch
 * run completes. Wide enough to capture both "markdown report from a
 * reviewer" and "diff annotations from a linter".
 */
export interface BatchInvocationOutput {
  /** Exit code from the agent's subprocess (0 = success). */
  exitCode: number;
  /** Human-readable markdown the mobile / web client renders as the
   *  agent's reply. */
  markdown?: string;
  /** Per-file hunks for reviewers that emit structured diffs. Empty
   *  when the agent only produces a single markdown blob. */
  hunks?: Array<{
    path: string;
    line?: number;
    severity?: 'info' | 'warn' | 'error';
    message: string;
  }>;
  /** Stats the runtime can surface in the UI (lines reviewed, count
   *  of suggestions, etc.). Free-form key/value. */
  stats?: Record<string, number | string>;
  /** Raw stdout/stderr for debugging or to surface verbatim. */
  rawStdout?: string;
  rawStderr?: string;
}

export interface BatchAgentStrategy extends BaseAgentStrategy {
  readonly mode: 'batch';

  /**
   * Default args injected before any caller-supplied ones (e.g.
   * `['--json']` for a reviewer that ships machine output by
   * default). Pure data — no side effects.
   */
  getDefaultArgs(): string[];

  /**
   * Build the `(cmd, args, env)` triple for one invocation given
   * caller input. The runtime is responsible for resolving the
   * binary via `this.os.findInPath(meta.binaryName)` and shell-
   * wrapping via `this.os.buildLaunch`. Throws when the input is
   * impossible to honor (e.g. `prMode` set but the agent's CLI
   * doesn't support it).
   */
  prepareInvocation(input: BatchInvocationInput): Promise<{
    cmd: string;
    args: string[];
    env?: Record<string, string>;
  }>;

  /**
   * Parse the agent's stdout (and optionally stderr + exit code)
   * into a structured `BatchInvocationOutput`. Called after the
   * subprocess exits. Implementations are stateless — multiple
   * concurrent runs of the same agent share this strategy instance.
   */
  parseOutput(args: {
    exitCode: number;
    stdout: string;
    stderr: string;
  }): BatchInvocationOutput;

  /**
   * Convenience: spawn the agent, wait for exit, parse output.
   * Most callers should use this; advanced flows (live progress
   * streaming, custom timeout) can compose `prepareInvocation +
   * spawn + parseOutput` directly.
   */
  runOneShot(input: BatchInvocationInput): Promise<BatchInvocationOutput>;
}

/**
 * Union covering every concrete agent strategy. Consumer code that
 * needs to operate on "any agent" types its variable as `AgentStrategy`
 * and narrows on `.mode` before reaching into mode-specific methods.
 */
export type AgentStrategy = InteractiveAgentStrategy | BatchAgentStrategy;

/**
 * Backward-compat alias used pervasively across the codebase. Pre-#58,
 * `RuntimeStrategy` was the only agent shape — all Interactive. Kept
 * exported so existing call sites compile unchanged.
 */
export type RuntimeStrategy = InteractiveAgentStrategy;

export interface LocalCredentialSource {
  source: 'flat-file' | 'macos-keychain' | 'env-var' | 'none';
  description: string;
}

export interface DeployStrategy {
  readonly id: AgentId;

  detectLocalCredentials(): Promise<LocalCredentialSource>;
  bridgeLocalCredentials(provider: CloudProvider, workspaceId: string): Promise<LocalCredentialSource>;
  setupOnWorkspace(
    provider: CloudProvider,
    workspaceId: string,
    opts: { bridged: LocalCredentialSource['source'] }
  ): Promise<void>;
  runRemoteLogin(provider: CloudProvider, workspaceId: string): Promise<void>;
}
