import * as vscode from 'vscode';
import { cspMeta } from '../utils/webview-security';
import { brandCssTokens } from '../ui/brand-tokens';

/**
 * The pairing webview's full HTML document — markup, brand CSS,
 * disconnected/connected views, and the inline message-handling
 * script. Owned by this module rather than the
 * `ControllerPanelProvider` so the controller can stay focused on
 * lifecycle + dispatch instead of string templates.
 *
 * Inputs:
 *   - `webview` — used for `cspSource` in the Content-Security-Policy
 *     meta tag (img / style / font sources).
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
export function renderPanelHtml(webview: vscode.Webview, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${cspMeta(webview, nonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    ${brandCssTokens()}
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 12px;
      font-size: 13px;
    }
    .card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 10px;
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
    .btn-primary:focus-visible {
      outline: 2px solid var(--ca-purple);
      outline-offset: 2px;
    }
    .btn-danger {
      background: var(--ca-error);
      color: var(--ca-on-surface);
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
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
      font-family: var(--vscode-editor-font-family), monospace;
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
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
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
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
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
  </style>
</head>
<body>
  <div id="disconnected-view">
    <div class="card">
      <div class="status-row">
        <div class="dot dot-red"></div>
        <span class="label">Disconnected</span>
      </div>
      <p class="muted">Pair your mobile device to control AI agents remotely.</p>
      <button id="btn-generate-pairing" class="btn btn-primary">Generate Pairing Code</button>
    </div>

    <div id="pairing-section" class="card hidden">
      <h3>Pairing Code</h3>
      <div id="qr-container" class="qr-container"></div>
      <div id="pairing-code" class="pairing-code">------</div>
      <p id="pairing-timer" class="expire-timer">Waiting for connection...</p>
      <p class="muted" style="text-align:center; margin-top:6px;">Enter this code in your mobile app</p>
    </div>

    <div id="recent-sessions-section" class="card hidden">
      <h3>Recent Sessions</h3>
      <div id="recent-sessions-list"></div>
    </div>
  </div>

  <div id="connected-view" class="hidden">
    <div class="card">
      <div class="status-row">
        <div id="status-dot" class="dot dot-green"></div>
        <span id="status-label" class="label">Connected</span>
      </div>
      <div class="user-info">
        <span id="user-name" class="user-name"></span>
        <span id="user-email" class="user-email"></span>
        <span id="user-plan" class="user-plan"></span>
      </div>
      <button id="btn-disconnect" class="btn btn-danger">Disconnect</button>
    </div>

    <div class="card">
      <h3>Detected AI Agents</h3>
      <div id="agents-list" class="agents-list">
        <p class="muted">Loading...</p>
      </div>
      <button id="btn-refresh-agents" class="btn btn-secondary">Refresh Agents</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = { connected: false, user: null, agents: [], connectionState: 'offline' };

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
        return '<div class="session-row">' +
          '<div class="session-info">' +
            '<div class="session-name">' + name + '</div>' +
            (email ? '<div class="session-email">' + email + '</div>' : '') +
          '</div>' +
          '<button class="btn-reconnect" data-sid="' + s.sessionId + '">Reconnect</button>' +
          '<button class="btn-delete" data-sid="' + s.sessionId + '" title="Delete session">✕</button>' +
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
    }

    function renderAgents(agents) {
      const container = document.getElementById('agents-list');
      if (!agents || agents.length === 0) {
        container.innerHTML = '<p class="muted">No AI agents detected</p>';
        return;
      }
      container.innerHTML = agents.map(a =>
        '<div class="agent-row"><div class="agent-dot"></div><span>' + a.name + '</span></div>'
      ).join('');
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'status':
          state.connected = msg.connected;
          state.user = msg.user;
          state.connectionState = msg.connectionState || 'offline';
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
          renderAgents(msg.agents);
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

    vscode.postMessage({ type: 'getStatus' });
  </script>
</body>
</html>`;
}
