import { TerminalAgentService } from '../../terminal-agent.service';
import { findExtension } from '../checks/extension';
import type { AgentDetector, DetectionContext, DetectionResult } from '../types';

/**
 * Detects Claude Code. Two signals:
 *   - The official VS Code extension(s).
 *   - An open "Claude Code" terminal tab (the user spun up `claude` in a
 *     VS Code terminal — the existing CLI flow this plugin supports).
 *
 * Either signal alone counts as "installed". When both are present the
 * extension id is the wire id and `isTerminalAgent: true` is set on top.
 * The detector id is `claude_code` so the fallback wire id is
 * `__terminal__:claude_code`, identical to the legacy hardcoded value.
 */
export class ClaudeCodeDetector implements AgentDetector {
  readonly id = 'claude_code';
  readonly name = 'Claude Code';
  readonly icon = 'claude';

  private static readonly CANDIDATE_EXTENSION_IDS = ['anthropic.claude-code', 'anthropics.claude'];

  async detect(ctx: DetectionContext): Promise<DetectionResult | null> {
    const extension = findExtension(ClaudeCodeDetector.CANDIDATE_EXTENSION_IDS, ctx.extensions);
    const terminalTab = TerminalAgentService.getInstance().findClaudeCodeTerminal();
    if (!extension && !terminalTab) return null;
    return {
      installed: true,
      extensionId: extension?.id ?? 'anthropic.claude-code',
      isTerminalAgent: !!terminalTab,
      via: extension ? 'extension' : 'terminal-tab',
    };
  }
}
