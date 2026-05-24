import { findExtension } from '../checks/extension';
import type { AgentDetector, DetectionContext, DetectionResult } from '../types';

/**
 * Generic "extension-id match only" detector — covers the long tail of
 * VS Code agents whose detection is just `vscode.extensions.getExtension(id)`
 * with no binary / config-dir fallback. Each instance owns one logical
 * agent (Copilot Chat, Tabnine, Cody, …) but can accept multiple
 * candidate extension ids so historical / fork ids match too.
 *
 * Specific behaviours (Anthropic Claude → terminal agent, OpenAI Codex →
 * terminal agent, Cursor's standalone CLI binary, etc.) get their own
 * detector class instead of this factory.
 */
export interface ExtensionOnlyConfig {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly extensionIds: readonly string[];
}

export class ExtensionOnlyDetector implements AgentDetector {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  private readonly extensionIds: readonly string[];

  constructor(config: ExtensionOnlyConfig) {
    this.id = config.id;
    this.name = config.name;
    this.icon = config.icon;
    this.extensionIds = config.extensionIds;
  }

  async detect(ctx: DetectionContext): Promise<DetectionResult | null> {
    const extension = findExtension(this.extensionIds, ctx.extensions);
    if (!extension) return null;
    ctx.log.appendLine(`Detected ${this.name} (${extension.id})`);
    return {
      installed: true,
      extensionId: extension.id,
      via: 'extension',
    };
  }
}
