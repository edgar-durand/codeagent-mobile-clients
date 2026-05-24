import { findExtension } from '../checks/extension';
import type { AgentDetector, DetectionContext, DetectionResult } from '../types';

/**
 * Detects Claude Code by the presence of the Anthropic VS Code
 * extension. Claude itself is a terminal agent owned by codeam-cli,
 * so we don't introspect a local Claude PTY here — we just report
 * presence to the mobile, which dispatches runtime commands to the
 * CLI's pluginId.
 */
export class ClaudeCodeDetector implements AgentDetector {
  readonly id = 'claude_code';
  readonly name = 'Claude Code';
  readonly icon = 'claude';

  private static readonly CANDIDATE_EXTENSION_IDS = ['anthropic.claude-code', 'anthropics.claude'];

  async detect(ctx: DetectionContext): Promise<DetectionResult | null> {
    const extension = findExtension(ClaudeCodeDetector.CANDIDATE_EXTENSION_IDS, ctx.extensions);
    if (!extension) return null;
    return {
      installed: true,
      extensionId: extension.id,
      isTerminalAgent: true,
      via: 'extension',
    };
  }
}
