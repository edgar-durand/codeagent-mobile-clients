import * as vscode from 'vscode';
import { PROTOCOL_VERSION } from '@codeagent/shared';
import { CommandRelayService } from '../services/command-relay.service';
import { PairingService } from '../services/pairing.service';

/**
 * StatusBar entry for CodeAgent Mobile. Three visible states map to
 * the relay's `online / reconnecting / offline` triplet so the
 * status-bar visual matches the side-panel dot, never lying about
 * reachability. Tooltip is a MarkdownString with the paired user,
 * agent count, last-sync age, and the wire-protocol version — same
 * surface the side-panel exposes, condensed for an at-a-glance
 * read while the panel is closed.
 *
 * The bar item is owned by this class for the lifetime of the
 * extension; `attach()` returns the disposable the activator pushes
 * into `context.subscriptions`. A 5-second ticker repaints the
 * "Last sync" age without subscribing to every SSE frame — the
 * panel already runs a much hotter loop and we don't need that
 * cadence at the status-bar surface.
 */
export class StatusBar {
  private static instance: StatusBar | null = null;

  private readonly item: vscode.StatusBarItem;
  private readonly tickHandle: NodeJS.Timeout;
  private agentCount = 0;
  private agentNames: string[] = [];

  private constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'codeagent-mobile.openPanel';
    this.item.show();
    this.repaint();

    const relay = CommandRelayService.getInstance();
    relay.onConnectionChange(() => this.repaint());

    PairingService.getInstance().addListener({
      onPaired: () => this.repaint(),
    });

    // The "Last sync" age is the only time-varying field; a 5 s
    // ticker is enough resolution for "3 s ago" / "1 m ago" copy
    // without burning the event loop.
    this.tickHandle = setInterval(() => this.repaint(), 5000);
  }

  static initialize(): StatusBar {
    if (!StatusBar.instance) StatusBar.instance = new StatusBar();
    return StatusBar.instance;
  }

  static getInstance(): StatusBar {
    if (!StatusBar.instance) throw new Error('StatusBar not initialized');
    return StatusBar.instance;
  }

  /** Update the cached agents list so the tooltip can list them. */
  reportAgents(agents: Array<{ name: string }>): void {
    this.agentCount = agents.length;
    this.agentNames = agents.map((a) => a.name);
    this.repaint();
  }

  dispose(): void {
    clearInterval(this.tickHandle);
    this.item.dispose();
  }

  private repaint(): void {
    const relay = CommandRelayService.getInstance();
    const pairing = PairingService.getInstance();
    const state = relay.isPolling ? relay.getConnectionState() : 'offline';
    const user = pairing.pairedUser;

    switch (state) {
      case 'online':
        this.item.text = '$(broadcast) CodeAgent Mobile · ●';
        this.item.backgroundColor = undefined;
        break;
      case 'reconnecting':
        // Copy used to say "pairing" which confused users who were
        // already paired (QA Android #291). The state name is
        // "reconnecting" — surface that verbatim so the meaning is
        // unambiguous.
        this.item.text = '$(sync~spin) CodeAgent Mobile · reconnecting';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      default:
        this.item.text = '$(broadcast-slash) CodeAgent Mobile · ○';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
    }

    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    const stateLabel =
      state === 'online' ? 'Connected' : state === 'reconnecting' ? 'Reconnecting' : 'Offline';
    md.appendMarkdown(`**CodeAgent Mobile** (${stateLabel})\n\n`);
    if (user) {
      md.appendMarkdown(`\`${user.email}\`\n\n`);
    }
    if (this.agentCount === 0) {
      md.appendMarkdown('- No agents detected yet\n');
    } else {
      md.appendMarkdown(
        `- ${this.agentCount} agent${this.agentCount === 1 ? '' : 's'} detected (${this.agentNames.join(', ')})\n`,
      );
    }
    const lastSync = relay.getLastSuccessfulSyncMs();
    md.appendMarkdown(`- Last sync: ${formatAge(lastSync)}\n`);
    md.appendMarkdown(`- Protocol: v${PROTOCOL_VERSION}\n\n`);
    md.appendMarkdown('Click for actions ›');
    this.item.tooltip = md;
  }
}

function formatAge(lastSyncMs: number | null): string {
  if (lastSyncMs == null) return 'never';
  const ageSec = Math.max(0, Math.floor((Date.now() - lastSyncMs) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  const ageMin = Math.floor(ageSec / 60);
  if (ageMin < 60) return `${ageMin}m ago`;
  const ageHr = Math.floor(ageMin / 60);
  return `${ageHr}h ago`;
}
