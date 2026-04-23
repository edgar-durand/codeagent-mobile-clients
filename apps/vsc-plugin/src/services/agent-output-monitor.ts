import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { OutputChannel } from 'vscode';
import { SettingsService } from './settings.service';
import { CommandRelayService } from './command-relay.service';

export class AgentOutputMonitor {
  private static instance: AgentOutputMonitor;
  private log: OutputChannel;
  private monitorTimer: NodeJS.Timeout | null = null;
  private stableCount = 0;
  private hasEverCapturedContent = false;
  private currentSessionId: string | null = null;
  private currentPromptText = '';
  private _isMonitoring = false;
  private pollCount = 0;
  private lastSentResponseText = '';
  private responseDoneSent = false;
  private captureServer: http.Server | null = null;
  private latestCapturedContent = '';
  private pendingPrompt: string | null = null;

  private static readonly CAPTURE_PORT = 47832;
  private static readonly POLL_INTERVAL_MS = 2500;
  private static readonly STABLE_THRESHOLD = 3;
  private static readonly MAX_EMPTY_POLLS = 30;
  private static readonly OBSERVER_FILENAME = 'codeagent-observer.js';
  private static readonly SCRIPT_TAG = '<script src="./codeagent-observer.js"></script>';

  private constructor(log: OutputChannel) {
    this.log = log;
  }

  static initialize(log: OutputChannel): AgentOutputMonitor {
    AgentOutputMonitor.instance = new AgentOutputMonitor(log);
    return AgentOutputMonitor.instance;
  }

  static getInstance(): AgentOutputMonitor {
    if (!AgentOutputMonitor.instance) {
      throw new Error('AgentOutputMonitor not initialized');
    }
    return AgentOutputMonitor.instance;
  }

  get isActive(): boolean {
    return this._isMonitoring;
  }

  // ── Safe startup: start capture server and clean up any previous workbench injection ──

  async safeStartup(): Promise<void> {
    this.ensureCaptureServerRunning();
    await this.cleanupWorkbenchInjection();
  }

  private async cleanupWorkbenchInjection(): Promise<void> {
    try {
      const appRoot = vscode.env.appRoot;
      const workbenchDir = path.join(appRoot, 'out', 'vs', 'code', 'electron-browser', 'workbench');
      const workbenchHtml = path.join(workbenchDir, 'workbench.html');
      const observerJs = path.join(workbenchDir, AgentOutputMonitor.OBSERVER_FILENAME);

      let cleaned = false;

      // Remove injected script tag from workbench.html
      if (fs.existsSync(workbenchHtml)) {
        const html = fs.readFileSync(workbenchHtml, 'utf-8');
        if (html.includes(AgentOutputMonitor.OBSERVER_FILENAME)) {
          const restored = html
            .replace(`\t${AgentOutputMonitor.SCRIPT_TAG}\n`, '')
            .replace(AgentOutputMonitor.SCRIPT_TAG, '');
          fs.writeFileSync(workbenchHtml, restored, 'utf-8');
          this.log.appendLine('[cleanup] Removed script tag from workbench.html');
          cleaned = true;
        }
      }

      // Remove injected observer JS file
      if (fs.existsSync(observerJs)) {
        fs.unlinkSync(observerJs);
        this.log.appendLine('[cleanup] Removed observer JS file');
        cleaned = true;
      }

      if (cleaned) {
        const action = await vscode.window.showInformationMessage(
          'CodeAgent: Cleaned up previous workbench modification. Reload to fix "corrupt installation" warning.',
          'Reload Now',
          'Later',
        );
        if (action === 'Reload Now') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      }
    } catch (e) {
      this.log.appendLine(`[cleanup] Failed to clean workbench (non-critical): ${e}`);
    }
  }

  // ── Monitoring lifecycle ──

  startMonitoring(sessionId: string, promptText: string): void {
    this.stopMonitoring();
    this.currentSessionId = sessionId;
    this.currentPromptText = promptText.trim();
    this._isMonitoring = true;
    this.stableCount = 0;
    this.pollCount = 0;
    this.hasEverCapturedContent = false;
    this.responseDoneSent = false;
    this.lastSentResponseText = '';
    this.latestCapturedContent = '';

    this.clearRemoteOutput(sessionId);
    this.ensureCaptureServerRunning();

    this.monitorTimer = setInterval(() => {
      this.checkForChanges();
    }, AgentOutputMonitor.POLL_INTERVAL_MS);

    this.log.appendLine(`[monitor] Started for session=${sessionId}`);
  }

  stopMonitoring(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    this._isMonitoring = false;
    this.stableCount = 0;
    this.pollCount = 0;
    this.hasEverCapturedContent = false;
    this.responseDoneSent = false;
    this.log.appendLine('[monitor] Stopped');
  }

  dispose(): void {
    this.stopMonitoring();
    this.stopCaptureServer();
  }

  // ── HTTP Capture Server (fixed port, persistent) ──

  private ensureCaptureServerRunning(): void {
    if (this.captureServer) { return; }
    this.startCaptureServer();
  }

  private startCaptureServer(): void {
    this.stopCaptureServer();
    this.captureServer = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method === 'GET' && req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('pong');
        return;
      }
      if (req.method === 'GET' && req.url === '/pending-prompt') {
        const prompt = this.pendingPrompt;
        this.pendingPrompt = null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ prompt: prompt || '' }));
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        if (req.url === '/submit' && body.length > 0) {
          this.pendingPrompt = body;
          this.log.appendLine(`[server] Prompt queued (${body.length} chars)`);
          res.writeHead(200); res.end('queued');
          return;
        }
        if (body.length > 0) { this.latestCapturedContent = body; }
        res.writeHead(200); res.end('ok');
      });
    });
    this.captureServer.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        this.log.appendLine(`[server] Port ${AgentOutputMonitor.CAPTURE_PORT} busy, retry in 3s`);
        setTimeout(() => this.startCaptureServer(), 3000);
      } else {
        this.log.appendLine(`[server] Error: ${e.message}`);
      }
    });
    this.captureServer.listen(AgentOutputMonitor.CAPTURE_PORT, '127.0.0.1', () => {
      this.log.appendLine(`[server] Listening on port ${AgentOutputMonitor.CAPTURE_PORT}`);
    });
  }

  private stopCaptureServer(): void {
    try { this.captureServer?.close(); } catch { /* ignore */ }
    this.captureServer = null;
  }

  // ── Observer Script (runs inside IDE renderer via workbench.html) ──

  private buildObserverScript(): string {
    const port = AgentOutputMonitor.CAPTURE_PORT;
    const version = '5.0.0';
    return `// CodeAgent Chat Observer v${version} — managed by CodeAgent Mobile extension
(function() {
  var PORT = ${port};
  var BASE = "http://127.0.0.1:" + PORT;
  var last = "";
  var obs = null;
  var chatEl = null;
  var TAG = "[CodeAgent]";
  var serverReady = false;
  var waitingForServer = false;
  var captureTimer = null;
  var promptTimer = null;
  var failCount = 0;

  // Debug state is exposed on window.__codeagent for inspection from DevTools.
  // No console logs — the extension host's OutputChannel is the canonical log.
  window.__codeagent = { version: "${version}", loaded: true, serverReady: false, chatFound: false, editorFound: false, ide: "unknown", lastError: null };

  // Multi-IDE editor selectors (order matters: most specific first)
  var EDITOR_SELECTORS = [
    '[data-lexical-editor="true"][contenteditable="true"]',
    '.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]'
  ];

  function findEditor() {
    for (var i = 0; i < EDITOR_SELECTORS.length; i++) {
      var el = document.querySelector(EDITOR_SELECTORS[i]);
      if (el) return el;
    }
    return null;
  }

  function detectIDE() {
    if (document.getElementById("chat")) return "windsurf";
    if (document.querySelector(".ProseMirror")) return "cursor";
    if (document.querySelector('[data-lexical-editor="true"]')) return "windsurf";
    return "vscode";
  }

  function sendCapture() {
    if (!chatEl || !serverReady) return;
    var t = chatEl.innerText || "";
    if (t === last) return;
    last = t;
    fetch(BASE + "/capture", { method: "POST", body: t })
      .then(function() { failCount = 0; })
      .catch(function() { handleDisconnect(); });
  }

  function handleDisconnect() {
    failCount++;
    if (failCount > 3 && serverReady) {
      serverReady = false;
      window.__codeagent.serverReady = false;
      window.__codeagent.lastError = "disconnected";
      beginWaitForServer();
    }
  }

  function submitPrompt(text) {
    var editor = findEditor();
    if (!editor) {
      window.__codeagent.lastError = "no-editor-found";
      return false;
    }
    editor.focus();

    var sel = window.getSelection();
    if (sel) { sel.selectAllChildren(editor); sel.deleteFromDocument(); }

    editor.dispatchEvent(new InputEvent("beforeinput", {
      inputType: "insertText", data: text,
      bubbles: true, cancelable: true, composed: true
    }));

    setTimeout(function() {
      var btn = document.querySelector('button[type="submit"]:not([disabled])');
      if (!btn) btn = document.querySelector('button.rounded-full[type="submit"]');
      if (!btn) btn = document.querySelector('[data-testid="submit-button"]');
      if (!btn) btn = document.querySelector('button[aria-label*="Send"], button[aria-label*="send"]');
      if (btn) { btn.click(); }
      else {
        editor.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, composed: true
        }));
      }
    }, 300);
    return true;
  }

  function pollPrompts() {
    if (!serverReady) return;
    fetch(BASE + "/pending-prompt")
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.prompt) {
          failCount = 0;
          submitPrompt(data.prompt);
        }
      })
      .catch(function() { handleDisconnect(); });
  }

  function beginWaitForServer() {
    if (waitingForServer) return;
    waitingForServer = true;
    if (captureTimer) { clearInterval(captureTimer); captureTimer = null; }
    if (promptTimer) { clearInterval(promptTimer); promptTimer = null; }
    doWait();
  }

  function doWait() {
    fetch(BASE + "/ping")
      .then(function(r) {
        if (r.ok) {
          serverReady = true;
          waitingForServer = false;
          failCount = 0;
          window.__codeagent.serverReady = true;
          window.__codeagent.lastError = null;
          if (chatEl) { captureTimer = setInterval(sendCapture, 2000); }
          promptTimer = setInterval(pollPrompts, 500);
          if (chatEl) { sendCapture(); }
        } else { setTimeout(doWait, 2000); }
      })
      .catch(function() { setTimeout(doWait, 2000); });
  }

  function attach() {
    var ide = detectIDE();
    window.__codeagent.ide = ide;

    // Windsurf: #chat container for streaming capture
    chatEl = document.getElementById("chat");

    // Cursor/VSCode: walk up from editor to find a chat container
    if (!chatEl) {
      var editor = findEditor();
      if (editor) {
        var p = editor;
        for (var i = 0; i < 20 && p; i++) {
          p = p.parentElement;
          if (p && p.scrollHeight > 400) { chatEl = p; break; }
        }
      }
    }

    var hasEditor = !!findEditor();

    if (!chatEl && !hasEditor) {
      setTimeout(attach, 3000);
      return;
    }

    window.__codeagent.chatFound = !!chatEl;
    window.__codeagent.editorFound = hasEditor;

    if (chatEl) {
      if (obs) { try { obs.disconnect(); } catch(e) {} }
      obs = new MutationObserver(sendCapture);
      obs.observe(chatEl, { childList: true, subtree: true, characterData: true });
    }

    beginWaitForServer();
  }

  if (document.readyState === "complete") { setTimeout(attach, 2000); }
  else { window.addEventListener("load", function() { setTimeout(attach, 2000); }); }
})();
`;
  }

  // ── Content Polling ──

  private checkForChanges(): void {
    if (!this._isMonitoring) { return; }
    const sessionId = this.currentSessionId;
    if (!sessionId) { return; }
    this.pollCount++;

    const currentContent = this.latestCapturedContent;

    if (!currentContent || currentContent.length < 5) {
      if (!this.hasEverCapturedContent && this.pollCount >= AgentOutputMonitor.MAX_EMPTY_POLLS) {
        this.log.appendLine(`[monitor] No content after ${this.pollCount} polls, stopping`);
        this.pushOutput(sessionId, 'status', '', true);
        this.stopMonitoring();
      }
      return;
    }

    const response = this.extractResponseAfterPrompt(currentContent);

    if (!response || response === this.lastSentResponseText) {
      this.stableCount++;
      const threshold = this.hasEverCapturedContent
        ? AgentOutputMonitor.STABLE_THRESHOLD
        : AgentOutputMonitor.STABLE_THRESHOLD * 3;

      if (this.stableCount >= threshold && this.hasEverCapturedContent && !this.responseDoneSent) {
        this.log.appendLine(`[monitor] Stabilized (${this.lastSentResponseText.length} chars), stopping`);
        this.pushOutput(sessionId, 'text', this.lastSentResponseText, true);
        this.responseDoneSent = true;
        this.stopMonitoring();
      }
      return;
    }

    this.stableCount = 0;

    const isEcho = this.currentPromptText.length > 0 && (
      response.trim() === this.currentPromptText.trim() ||
      this.currentPromptText.trim().endsWith(response.trim())
    );
    if (isEcho) { return; }

    this.hasEverCapturedContent = true;
    this.lastSentResponseText = response;
    const preview = response.substring(0, 80).replace(/\n/g, '\\n');
    this.log.appendLine(`[monitor] Output (${response.length} chars): ${preview}`);
    this.pushOutput(sessionId, 'text', response, false);
  }

  // ── Response Extraction ──

  private extractResponseAfterPrompt(pageText: string): string {
    const cleaned = this.cleanText(pageText);
    if (!this.currentPromptText) { return cleaned; }

    const idx = cleaned.lastIndexOf(this.currentPromptText);
    if (idx >= 0) {
      return this.stripNoise(cleaned.substring(idx + this.currentPromptText.length).trim());
    }

    const partial = this.currentPromptText.substring(0, 30);
    if (partial.length > 5) {
      const pIdx = cleaned.lastIndexOf(partial);
      if (pIdx >= 0) {
        const eol = cleaned.indexOf('\n', pIdx);
        if (eol >= 0) { return this.stripNoise(cleaned.substring(eol + 1).trim()); }
      }
    }
    return '';
  }

  private cleanText(text: string): string {
    return text.replace(/Drop to add to \w+/g, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  private stripNoise(text: string): string {
    const patterns = [
      'Feedback submitted', 'Command Awaiting Approval', 'Ask anything',
      'Claude Opus', 'Claude Sonnet', 'GPT-4', 'GPT-5', 'Claude 4', 'Claude 3',
    ];
    let r = text;
    for (const p of patterns) {
      const i = r.indexOf(p);
      if (i > 0) { r = r.substring(0, i).trim(); }
    }
    return r.replace(/👍|👎/g, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ── API Communication ──

  private pushOutput(sessionId: string, type: string, content: string, done: boolean): void {
    const settings = SettingsService.getInstance();
    const relay = CommandRelayService.getInstance();
    const pluginId = settings.ensurePluginId();
    relay.postJson(`${settings.apiBaseUrl}/api/commands/output`, {
      sessionId, pluginId, type, content, done,
    }).catch((e) => {
      this.log.appendLine(`[monitor] Push failed: ${e}`);
    });
  }

  private clearRemoteOutput(sessionId: string): void {
    const settings = SettingsService.getInstance();
    const relay = CommandRelayService.getInstance();
    const pluginId = settings.ensurePluginId();
    relay.postJson(`${settings.apiBaseUrl}/api/commands/output`, {
      sessionId, pluginId, clear: true,
    }).catch(() => {});
  }
}
