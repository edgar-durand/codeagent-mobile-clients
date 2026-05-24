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

export interface RuntimeStrategy {
  readonly id: AgentId;
  readonly meta: AgentMetadata;
  /**
   * Per-OS primitives the strategy composes for spawn / PATH /
   * shell-escape / temp-file work. Each platform impl (darwin,
   * linux, win32) is interchangeable; no concrete RuntimeStrategy
   * should branch on `process.platform` — it should ask `this.os`
   * instead.
   */
  readonly os: OsStrategy;

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
