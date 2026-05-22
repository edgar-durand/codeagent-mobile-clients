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
