/**
 * Canonical user-facing strings for the VS Code extension. Locks the
 * notification voice to `CodeAgent Mobile · <message>.` — middle-dot
 * separator + period — so the brand name doesn't drift across files
 * and so we never leak implementation details ("workbench
 * modification", dev-log arrows) into the notification surface.
 *
 * The JetBrains side keeps a near-identical mirror at
 * `com.windsurf.controller.ui.BrandMessages.kt`. When you add an
 * entry here, mirror it there.
 */

const BRAND = 'CodeAgent Mobile';

const notification = (body: string): string => `${BRAND} · ${body}`;

export const Messages = {
  Disconnected: notification('Disconnected.'),
  ConnectedTo: (email: string): string => notification(`Connected as ${email}.`),
  SessionExpired: notification('Session expired. Re-pair to continue.'),
  EditorRestored: notification('Editor restored. Reload to clear the "corrupt installation" warning.'),
  PromptReceived: (preview: string): string => notification(`Prompt received — ${preview}.`),
  PromptSent: (preview: string): string => notification(`Prompt sent to AI — ${preview}.`),
  PromptCopiedToClipboard: notification('Prompt copied to clipboard — paste it into the chat and press Enter.'),
  EmptyAgentList: 'No agents detected yet. Install Claude Code or sign in to Copilot, then refresh.',
  EmptyRecentSessions: 'No recent sessions yet. Generate a pairing code to start.',
} as const;
