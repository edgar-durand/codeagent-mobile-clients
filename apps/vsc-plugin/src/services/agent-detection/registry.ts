import { ClaudeCodeDetector } from './detectors/claude-code.detector';
import { CodexDetector } from './detectors/codex.detector';
import type { AgentDetector, DetectionContext, DetectionResult, DetectedAgent } from './types';

export const DETECTORS: readonly AgentDetector[] = [new ClaudeCodeDetector(), new CodexDetector()];

export function toDetectedAgent(d: AgentDetector, r: DetectionResult): DetectedAgent {
  const id = r.via === 'extension' ? r.extensionId : `__terminal__:${d.id}`;
  return {
    id,
    name: d.name,
    extensionId: r.extensionId,
    icon: d.icon,
    installed: true,
    isTerminalAgent: r.isTerminalAgent,
    isLmAgent: r.isLmAgent,
  };
}

export async function runDetectors(
  detectors: readonly AgentDetector[],
  ctx: DetectionContext,
): Promise<DetectedAgent[]> {
  const results = await Promise.all(
    detectors.map(async (d) => {
      try {
        const r = await d.detect(ctx);
        return r ? toDetectedAgent(d, r) : null;
      } catch (e) {
        ctx.log.appendLine(`[agent-detection] ${d.id} threw: ${String(e)}`);
        return null;
      }
    }),
  );
  return results.filter((x): x is DetectedAgent => x !== null);
}
