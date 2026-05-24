import type { AgentId, AgentMetadata, AgentModel, ChromeStep, NormalizedMessage, SelectPrompt } from '@codeagent/shared';
import type { OsStrategy } from '../os';
import type { CloudProvider } from '../services/providers/types';

export interface ChangeModelInstruction {
  type: 'pty' | 'restart';
  ptyInput?: string;
  restartArgs?: string[];
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
  resumeLaunchArgs(sessionId: string): string[];
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
