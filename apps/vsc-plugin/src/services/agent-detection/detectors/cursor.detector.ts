import { whichBinary } from '../checks/binary';
import { dirExists, expandHome } from '../checks/config-dir';
import type { AgentDetector, DetectionContext, DetectionResult } from '../types';

/**
 * Detects Cursor's headless CLI agent. Two signals, first hit wins:
 *
 *   1. The `cursor-agent` binary on PATH.
 *   2. The `~/.cursor/` config directory (created by Cursor IDE on
 *      first launch; also produced by the `cursor-agent login` flow).
 *
 * Cursor itself is a VS Code fork that does NOT publish a marketplace
 * extension into upstream VS Code, so there's no extension probe — the
 * binary / config-dir cover both the standalone-CLI and inside-Cursor
 * install paths.
 *
 * Every branch returns `isTerminalAgent: true` so the mobile knows to
 * dispatch runtime commands (start_task / select_option / …) to
 * codeam-cli's pluginId rather than this plugin.
 */
export class CursorDetector implements AgentDetector {
  readonly id = 'cursor';
  readonly name = 'Cursor Agent';
  readonly icon = 'cursor';

  private static readonly BINARY_NAME = 'cursor-agent';
  private static readonly CONFIG_DIR = '~/.cursor';

  async detect(ctx: DetectionContext): Promise<DetectionResult | null> {
    const binPath = await whichBinary(CursorDetector.BINARY_NAME);
    if (binPath) {
      ctx.log.appendLine(`[CursorDetector] binary at ${binPath}`);
      return {
        installed: true,
        extensionId: `__binary__:${CursorDetector.BINARY_NAME}`,
        isTerminalAgent: true,
        via: 'binary',
      };
    }

    if (await dirExists(expandHome(CursorDetector.CONFIG_DIR))) {
      ctx.log.appendLine(`[CursorDetector] config dir ${CursorDetector.CONFIG_DIR} present`);
      return {
        installed: true,
        extensionId: `__config__:${CursorDetector.BINARY_NAME}`,
        isTerminalAgent: true,
        via: 'config-dir',
      };
    }

    return null;
  }
}
