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

export interface DetectedAgentLike {
  id: string;
  name: string;
  extensionId: string;
  icon: string;
  installed: boolean;
  isTerminalAgent?: boolean;
  isLmAgent?: boolean;
}
