import type * as vscode from 'vscode';

export interface AgentDetector {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  detect(ctx: DetectionContext): Promise<DetectionResult | null>;
}

export interface DetectionContext {
  log: vscode.OutputChannel;
  extensions: readonly vscode.Extension<unknown>[];
}

export interface DetectionResult {
  installed: true;
  extensionId: string;
  isTerminalAgent?: boolean;
  isLmAgent?: boolean;
  via: 'extension' | 'binary' | 'config-dir' | 'terminal-tab';
  /**
   * Optional override for the emitted DetectedAgent's `name` —
   * lets detectors expose a runtime-computed display name
   * (e.g. "VS Code Chat (Claude Sonnet 4.6)") without hard-coding
   * the suffix into the detector's static `name`.
   */
  displayNameOverride?: string;
  /**
   * Optional override for the emitted DetectedAgent's `id` —
   * lets detectors pick a wire id distinct from the detector's static
   * `id` (e.g. VsCodeChatDetector emits `__vscode_lm__:copilot` so
   * the mobile picker's wire contract is preserved).
   */
  idOverride?: string;
}

/**
 * Canonical DetectedAgent type — shared between the agent-detection
 * registry and IdeIntegrationService. Defined here (in types.ts) so
 * registry.ts can reference it without importing from the service file
 * (which would create a circular dependency).
 *
 * IdeIntegrationService re-exports this so callers that previously
 * imported DetectedAgent from the service file continue to work.
 */
export interface DetectedAgent {
  id: string;
  name: string;
  extensionId: string;
  icon: string;
  installed: boolean;
  isTerminalAgent?: boolean;
  isLmAgent?: boolean;
}

/** @deprecated Use DetectedAgent directly. */
export type DetectedAgentLike = DetectedAgent;
