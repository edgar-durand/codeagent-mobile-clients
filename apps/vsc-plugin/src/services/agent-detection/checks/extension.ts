import type * as vscode from 'vscode';

/**
 * Case-insensitive lookup across a list of candidate extension ids.
 * Returns the first match found in `extensions`, preserving the original
 * casing of the installed extension (some publishers use mixed-case ids,
 * e.g. `GitHub.copilot`).
 *
 * Extracted from `IdeIntegrationService.findExtensionCaseInsensitive`.
 */
export function findExtension(
  candidateIds: readonly string[],
  extensions: readonly vscode.Extension<unknown>[],
): vscode.Extension<unknown> | undefined {
  for (const candidate of candidateIds) {
    const direct = extensions.find((e) => e.id === candidate);
    if (direct) return direct;
    const lower = candidate.toLowerCase();
    const ci = extensions.find((e) => e.id.toLowerCase() === lower);
    if (ci) return ci;
  }
  return undefined;
}
