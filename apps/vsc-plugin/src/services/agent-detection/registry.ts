import type { AgentDetector, DetectionContext, DetectionResult, DetectedAgentLike } from './types';

export const DETECTORS: readonly AgentDetector[] = [];

export function toDetectedAgent(d: AgentDetector, r: DetectionResult): DetectedAgentLike {
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
): Promise<DetectedAgentLike[]> {
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
  return results.filter((x): x is DetectedAgentLike => x !== null);
}
