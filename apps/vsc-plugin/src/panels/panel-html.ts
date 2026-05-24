import * as vscode from 'vscode';
import { cspMeta } from '../utils/webview-security';
import { brandCssTokens } from '../ui/brand-tokens';
import { Messages } from '../ui/messages';

/**
 * The pairing webview's full HTML document — markup, brand CSS,
 * disconnected/connected views, and the inline message-handling
 * script. Owned by this module rather than the
 * `ControllerPanelProvider` so the controller can stay focused on
 * lifecycle + dispatch instead of string templates.
 *
 * Inputs:
 *   - `webview` — used for `cspSource` in the CSP meta tag (img /
 *     style / font sources) and `asWebviewUri` for bundled fonts.
 *   - `extensionUri` — base URI for resolving bundled font assets
 *     under `resources/fonts/`.
 *   - `nonce` — per-resolve random string; bound to the inline
 *     `<script>` so a malicious string in the postMessage stream
 *     can't inject executable code.
 *
 * Why the script is inline rather than a webview resource: VS Code's
 * webview `localResourceRoots` would require shipping a separate JS
 * file in `resources/` and `asWebviewUri`-ing it; with our CSP
 * (`script-src 'nonce-...'`) the nonce-tagged inline block is the
 * same security posture with a single template.
 */
export function renderPanelHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  nonce: string,
): string {
  const hankenUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'resources', 'fonts', 'HankenGrotesk[wght].ttf'),
  );
  const jbMonoUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'resources', 'fonts', 'JetBrainsMono[wght].ttf'),
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${cspMeta(webview, nonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    /* Brand typography. Variable-axis TTFs ship under
       resources/fonts/ — webview.cspSource covers font-src so the
       webview-uri loads through the CSP without an exception. */
    @font-face {
      font-family: 'Hanken Grotesk';
      font-style: normal;
      font-weight: 100 900;
      font-display: swap;
      src: url('${hankenUri}') format('truetype-variations');
    }
    @font-face {
      font-family: 'JetBrains Mono';
      font-style: normal;
      font-weight: 100 800;
      font-display: swap;
      src: url('${jbMonoUri}') format('truetype-variations');
    }
    ${brandCssTokens()}
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      /* Hanken Grotesk is the brand display + body font (mixed
         case). Fall back to the host's UI font if @font-face fails
         to load — the layout stays intact, just slightly off-brand. */
      font-family: 'Hanken Grotesk', var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 12px;
      font-size: 13px;
    }
    /* GlassCard primitive — mirrors the mobile DLS surface. Layered
       on top of the host theme: keep the theme-aware background +
       border for light themes, then add a subtle electric-purple
       border tint + glow shadow so the card reads as ours, not as a
       raw VS Code panel. */
    .card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 8px;
      padding: 14px;
      margin-bottom: 12px;
      box-shadow: 0 0 0 1px rgba(168, 85, 247, 0.08) inset,
                  0 1px 8px rgba(168, 85, 247, 0.05);
      transition: box-shadow 160ms ease, border-color 160ms ease;
    }
    .card:hover {
      border-color: rgba(168, 85, 247, 0.25);
      box-shadow: 0 0 0 1px rgba(168, 85, 247, 0.15) inset,
                  0 0 16px rgba(168, 85, 247, 0.12);
    }
    .status-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .dot-green { background: var(--ca-success); box-shadow: 0 0 6px rgba(0, 255, 160, 0.6); }
    .dot-red { background: var(--ca-error); box-shadow: 0 0 6px rgba(255, 68, 68, 0.5); }
    .dot-yellow { background: var(--ca-warning); }
    .label { font-weight: 600; }
    .muted { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .btn {
      display: block;
      width: 100%;
      padding: 8px 12px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      text-align: center;
      margin-top: 8px;
    }
    .btn-primary {
      background: var(--ca-purple);
      color: var(--ca-on-surface);
      box-shadow: 0 0 12px var(--ca-glow-purple);
    }
    .btn-primary:hover { filter: brightness(1.08); }
    .btn-danger {
      background: var(--ca-error);
      color: var(--ca-on-surface);
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    /* A11y: 2-px electric-purple focus ring on every interactive
       control. We override VS Code's default focus border because
       its contrast against the panel background is below WCAG AA
       in dark themes — the brand purple sits well clear of any
       theme background and matches the panel's accent voice. */
    .btn:focus-visible,
    .btn-reconnect:focus-visible,
    .btn-delete:focus-visible {
      outline: 2px solid var(--ca-purple);
      outline-offset: 2px;
    }
    .agents-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .agents-actions .btn { flex: 1 1 auto; }
    .pairing-code {
      font-size: 28px;
      font-weight: 700;
      text-align: center;
      letter-spacing: 6px;
      color: var(--ca-purple);
      padding: 12px;
      background: var(--vscode-textBlockQuote-background);
      border-radius: 6px;
      margin: 8px 0;
      text-shadow: 0 0 14px var(--ca-glow-purple);
      font-family: 'JetBrains Mono', var(--vscode-editor-font-family), monospace;
    }
    .user-info {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .user-name { font-weight: 600; font-size: 14px; }
    .user-email { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .user-plan {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      /* JetBrains Mono on uppercase labels mirrors the mobile DLS. */
      font-family: 'JetBrains Mono', var(--vscode-editor-font-family), monospace;
    }
    .agents-list { margin-top: 8px; }
    .agent-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 0;
      font-size: 12px;
    }
    .agent-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #22c55e;
      flex-shrink: 0;
    }
    h3 {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--ca-purple);
      margin: 0 0 10px;
      /* DLS rule: uppercase labels in JetBrains Mono. */
      font-family: 'JetBrains Mono', var(--vscode-editor-font-family), monospace;
    }
    .hidden { display: none; }
    .expire-timer { font-size: 11px; color: var(--vscode-descriptionForeground); text-align: center; }
    .qr-container { text-align: center; margin: 12px 0 8px; }
    .qr-container img { border-radius: 8px; background: #fff; padding: 8px; }
    .session-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      border-radius: 4px;
      margin-bottom: 4px;
    }
    .session-row:hover { background: var(--vscode-list-hoverBackground); }
    .session-info { flex: 1; min-width: 0; }
    .session-name { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .session-email { font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .btn-reconnect {
      font-size: 10px;
      padding: 3px 8px;
      border: 1px solid var(--vscode-button-background);
      background: transparent;
      color: var(--vscode-button-background);
      border-radius: 3px;
      cursor: pointer;
      flex-shrink: 0;
      margin-left: 6px;
    }
    .btn-reconnect:hover { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-delete {
      font-size: 10px;
      padding: 3px 6px;
      border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
      background: transparent;
      color: var(--vscode-errorForeground);
      border-radius: 3px;
      cursor: pointer;
      flex-shrink: 0;
      margin-left: 4px;
      line-height: 1;
    }
    .btn-delete:hover { background: var(--vscode-inputValidation-errorBackground); }

    /* FooterStatusStrip — mirrors the mobile app surface. Fixed to
       the bottom of the panel viewport (position: sticky) so the
       summary is visible without scrolling regardless of how tall
       the agents / sessions cards grow. body padding-bottom leaves
       room so cards don't sit under the strip. */
    body { padding-bottom: 36px; }
    #footer-strip {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      height: 28px;
      padding: 0 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: 'Hanken Grotesk', var(--vscode-font-family);
      font-size: 11px;
      color: var(--ca-on-surface);
      background: var(--vscode-sideBar-background);
      border-top: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.08));
      z-index: 5;
    }
    .footer-dot {
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }
    .footer-dot-online {
      background: var(--ca-success);
      box-shadow: 0 0 6px var(--ca-success);
    }
    .footer-dot-reconnecting { background: var(--ca-warning); }
    .footer-dot-offline { background: var(--ca-error); }
    .footer-sep { color: var(--vscode-descriptionForeground); }
    .footer-mono { font-family: 'JetBrains Mono', var(--vscode-editor-font-family), monospace; }
  </style>
</head>
<body>
  <div id="disconnected-view" role="region" aria-label="Pairing">
    <div class="card">
      <div class="status-row" role="status" aria-live="polite">
        <div class="dot dot-red" aria-hidden="true"></div>
        <span class="label">Disconnected</span>
      </div>
      <p class="muted">Pair your mobile device to control AI agents remotely.</p>
      <button id="btn-generate-pairing" class="btn btn-primary"
              aria-label="Generate a pairing code to connect a mobile device">
        Generate Pairing Code
      </button>
    </div>

    <div id="pairing-section" class="card hidden" aria-live="polite">
      <h3>Pairing Code</h3>
      <div id="qr-container" class="qr-container" role="img" aria-label="Pairing QR code"></div>
      <div id="pairing-code" class="pairing-code" aria-label="Six-character pairing code">------</div>
      <p id="pairing-timer" class="expire-timer">Waiting for connection...</p>
      <p class="muted" style="text-align:center; margin-top:6px;">Enter this code in your mobile app</p>
    </div>

    <div id="recent-sessions-section" class="card hidden" role="region" aria-label="Recent sessions">
      <h3>Recent Sessions</h3>
      <div id="recent-sessions-list" role="list"></div>
    </div>
  </div>

  <div id="connected-view" class="hidden" role="region" aria-label="Connected session">
    <div class="card">
      <div class="status-row" role="status" aria-live="polite">
        <div id="status-dot" class="dot dot-green" aria-hidden="true"></div>
        <span id="status-label" class="label">Connected</span>
      </div>
      <div class="user-info">
        <span id="user-name" class="user-name"></span>
        <span id="user-email" class="user-email"></span>
        <span id="user-plan" class="user-plan"></span>
      </div>
      <button id="btn-disconnect" class="btn btn-danger"
              aria-label="Disconnect the paired mobile device">
        Disconnect
      </button>
    </div>

    <div class="card" role="region" aria-label="Detected agents">
      <h3>Detected AI Agents</h3>
      <div id="agents-list" class="agents-list" role="list" aria-live="polite">
        <p class="muted">Loading...</p>
      </div>
      <div class="agents-actions">
        <button id="btn-refresh-agents" class="btn btn-secondary"
                aria-label="Re-scan installed AI agents">
          Refresh Agents
        </button>
        <button id="btn-copy-install" class="btn btn-secondary hidden"
                aria-label="Copy the Claude Code install command to the clipboard">
          Copy Install Command
        </button>
      </div>
    </div>
  </div>

  <!--
    Footer status strip — fixed to the bottom of the panel, mirrors
    the mobile app's FooterStatusStrip surface (connection dot +
    agent count + last-sync age). Reads from the same connection-
    state store the status bar's tooltip uses; no new wire calls.
  -->
  <div id="footer-strip" role="status" aria-live="polite" aria-label="Connection summary">
    <span id="footer-dot" class="footer-dot footer-dot-offline" aria-hidden="true"></span>
    <span id="footer-state">Offline</span>
    <span class="footer-sep" aria-hidden="true">·</span>
    <span id="footer-agents">0 agents</span>
    <span class="footer-sep" aria-hidden="true">·</span>
    <span id="footer-sync" class="footer-mono">never</span>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = {
      connected: false,
      user: null,
      agents: [],
      connectionState: 'offline',
      lastSyncMs: null,
    };

    /** Escape user-controlled strings before splicing them into
     *  innerHTML / aria-label attributes. The backend already
     *  validates the pairing flow, but defence in depth is cheap. */
    function escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function requestPairing() {
      vscode.postMessage({ type: 'requestPairingCode' });
    }

    function disconnect() {
      vscode.postMessage({ type: 'disconnect' });
    }

    function refreshAgents() {
      vscode.postMessage({ type: 'refreshAgents' });
    }

    function reconnect(sessionId) {
      vscode.postMessage({ type: 'reconnect', sessionId: sessionId });
    }

    function deleteSession(sessionId) {
      vscode.postMessage({ type: 'deleteSession', sessionId: sessionId });
    }

    function renderRecentSessions(sessions) {
      const section = document.getElementById('recent-sessions-section');
      const list = document.getElementById('recent-sessions-list');
      if (!sessions || sessions.length === 0) {
        section.classList.add('hidden');
        return;
      }
      section.classList.remove('hidden');
      list.innerHTML = sessions.map(function(s) {
        var name = s.userName || s.userEmail || 'Unknown';
        var email = s.userName && s.userEmail ? s.userEmail : '';
        var who = escapeHtml(name + (email ? ' (' + email + ')' : ''));
        var sid = escapeHtml(s.sessionId);
        return '<div class="session-row" role="listitem">' +
          '<div class="session-info">' +
            '<div class="session-name">' + escapeHtml(name) + '</div>' +
            (email ? '<div class="session-email">' + escapeHtml(email) + '</div>' : '') +
          '</div>' +
          '<button class="btn-reconnect" data-sid="' + sid + '"' +
            ' aria-label="Reconnect to session for ' + who + '">Reconnect</button>' +
          '<button class="btn-delete" data-sid="' + sid + '"' +
            ' aria-label="Delete session for ' + who + '"' +
            ' title="Delete session">✕</button>' +
        '</div>';
      }).join('');
      list.querySelectorAll('.btn-reconnect').forEach(function(btn) {
        btn.addEventListener('click', function() {
          reconnect(btn.getAttribute('data-sid'));
        });
      });
      list.querySelectorAll('.btn-delete').forEach(function(btn) {
        btn.addEventListener('click', function() {
          deleteSession(btn.getAttribute('data-sid'));
        });
      });
    }

    function updateUI() {
      const dv = document.getElementById('disconnected-view');
      const cv = document.getElementById('connected-view');

      if (state.connected) {
        dv.classList.add('hidden');
        cv.classList.remove('hidden');

        if (state.user) {
          document.getElementById('user-name').textContent = state.user.name || 'User';
          document.getElementById('user-email').textContent = state.user.email || '';
          document.getElementById('user-plan').textContent = state.user.plan || 'FREE';
        }

        // Drive the dot color + label from the 3-state connectionState
        // so the user sees an amber "Reconnecting" dot while SSE is
        // re-establishing instead of a green "Connected" that lies
        // about reachability.
        const dot = document.getElementById('status-dot');
        const label = document.getElementById('status-label');
        if (dot && label) {
          dot.classList.remove('dot-green', 'dot-yellow', 'dot-red');
          if (state.connectionState === 'reconnecting') {
            dot.classList.add('dot-yellow');
            label.textContent = 'Reconnecting…';
          } else if (state.connectionState === 'offline') {
            dot.classList.add('dot-red');
            label.textContent = 'Offline';
          } else {
            dot.classList.add('dot-green');
            label.textContent = 'Connected';
          }
        }
      } else {
        dv.classList.remove('hidden');
        cv.classList.add('hidden');
      }
      refreshFooter();
    }

    /**
     * Mobile FooterStatusStrip analog — connection dot + agent count
     * + last-sync age. Pulls everything from the local store
     * (already updated by the status / agents / lastSyncMs message
     * handlers), so this is cheap to call on every UI tick + every
     * second from the syncTicker.
     */
    function refreshFooter() {
      const dot = document.getElementById('footer-dot');
      const stateEl = document.getElementById('footer-state');
      const agentsEl = document.getElementById('footer-agents');
      const syncEl = document.getElementById('footer-sync');
      if (!dot || !stateEl || !agentsEl || !syncEl) return;

      const cs = state.connected ? state.connectionState : 'offline';
      dot.classList.remove('footer-dot-online', 'footer-dot-reconnecting', 'footer-dot-offline');
      if (cs === 'reconnecting') {
        dot.classList.add('footer-dot-reconnecting');
        stateEl.textContent = 'Reconnecting';
      } else if (cs === 'offline') {
        dot.classList.add('footer-dot-offline');
        stateEl.textContent = 'Offline';
      } else {
        dot.classList.add('footer-dot-online');
        stateEl.textContent = 'Connected';
      }

      const n = (state.agents || []).length;
      agentsEl.textContent = n === 1 ? '1 agent' : n + ' agents';

      syncEl.textContent = formatSyncAge(state.lastSyncMs);
    }

    function formatSyncAge(lastSyncMs) {
      if (lastSyncMs == null) return 'never';
      const ageSec = Math.max(0, Math.floor((Date.now() - lastSyncMs) / 1000));
      if (ageSec < 60) return ageSec + 's ago';
      const ageMin = Math.floor(ageSec / 60);
      if (ageMin < 60) return ageMin + 'm ago';
      const ageHr = Math.floor(ageMin / 60);
      return ageHr + 'h ago';
    }

    // Tick the footer "Last sync" age once per second — the syncMs
    // value itself only updates on SSE frames / polling success,
    // but the rendered "3s ago" string must keep climbing.
    setInterval(refreshFooter, 1000);

    // Every 5 s, re-request the latest status so the footer
    // lastSyncMs field stays current with the relay polling loop.
    // Without this the age would keep climbing even when the relay
    // just got a fresh frame, because the panel only emits status
    // on state transitions.
    setInterval(function() { vscode.postMessage({ type: 'getStatus' }); }, 5000);

    function renderAgents(agents) {
      const container = document.getElementById('agents-list');
      const copyBtn = document.getElementById('btn-copy-install');
      if (!agents || agents.length === 0) {
        container.innerHTML = '<p class="muted">${Messages.EmptyAgentList}</p>';
        copyBtn.classList.remove('hidden');
        return;
      }
      copyBtn.classList.add('hidden');
      container.innerHTML = agents.map(a =>
        '<div class="agent-row" role="listitem"><div class="agent-dot" aria-hidden="true"></div><span>' + escapeHtml(a.name) + '</span></div>'
      ).join('');
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'status':
          state.connected = msg.connected;
          state.user = msg.user;
          state.connectionState = msg.connectionState || 'offline';
          if (typeof msg.lastSyncMs === 'number') state.lastSyncMs = msg.lastSyncMs;
          updateUI();
          break;
        case 'pairingCode': {
          const section = document.getElementById('pairing-section');
          section.classList.remove('hidden');
          document.getElementById('pairing-code').textContent = msg.code;
          // SVG is rendered extension-side via the qrcode package and
          // arrives as a trusted string. We never load the pairing code
          // through a third-party host — it is a short-lived bearer
          // secret.
          const qr = document.getElementById('qr-container');
          if (msg.qrSvg) {
            qr.innerHTML = msg.qrSvg;
            const svg = qr.querySelector('svg');
            if (svg) {
              svg.setAttribute('width', '180');
              svg.setAttribute('height', '180');
              svg.setAttribute('aria-label', 'QR code for pairing code ' + msg.code);
            }
          } else {
            qr.innerHTML = '<p class="muted">QR unavailable — enter the code manually on your phone.</p>';
          }
          const timer = document.getElementById('pairing-timer');
          const expiresAt = msg.expiresAt;
          const interval = setInterval(() => {
            const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
            if (remaining <= 0) {
              clearInterval(interval);
              timer.textContent = 'Code expired. Generate a new one.';
              section.classList.add('hidden');
            } else {
              const min = Math.floor(remaining / 60);
              const sec = remaining % 60;
              timer.textContent = 'Expires in ' + min + ':' + String(sec).padStart(2, '0');
            }
          }, 1000);
          break;
        }
        case 'agents':
          state.agents = msg.agents || [];
          renderAgents(state.agents);
          refreshFooter();
          break;
        case 'recentSessions':
          renderRecentSessions(msg.sessions);
          break;
        case 'error':
          break;
      }
    });

    // Inline event handlers (onclick="...") are blocked by the webview's
    // CSP — wire buttons via addEventListener instead.
    document.getElementById('btn-generate-pairing').addEventListener('click', requestPairing);
    document.getElementById('btn-disconnect').addEventListener('click', disconnect);
    document.getElementById('btn-refresh-agents').addEventListener('click', refreshAgents);
    document.getElementById('btn-copy-install').addEventListener('click', function() {
      vscode.postMessage({ type: 'copyInstallCommand' });
    });

    vscode.postMessage({ type: 'getStatus' });
  </script>
</body>
</html>`;
}
