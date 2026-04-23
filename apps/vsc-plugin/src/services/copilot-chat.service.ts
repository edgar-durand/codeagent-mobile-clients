import * as vscode from 'vscode';
import { OutputChannel } from 'vscode';
import { SettingsService } from './settings.service';
import { CommandRelayService } from './command-relay.service';
import { ChatHistoryService } from './chat-history.service';

/**
 * Drives the GitHub Copilot Chat backend programmatically via the VS Code
 * Language Model API (vscode.lm). Does not open the Chat panel — instead
 * it executes the same language model the user's Copilot is configured
 * with, and streams tokens back to mobile over the relay.
 *
 * Requires an active GitHub Copilot subscription on the user's VS Code.
 */
export interface LmContextSnapshot {
  used: number;
  total: number;
  percent: number;
  model: string | null;
  outputTokens: number;
  cacheReadTokens: number;
  monthlyCost?: number;
  provider?: string;
  modelFamily?: string;
  error?: string;
}

export class CopilotChatService {
  private static instance: CopilotChatService;
  private log: OutputChannel;
  private activeCancel: vscode.CancellationTokenSource | null = null;

  // Cumulative token tracking for the current pairing session.
  private inputTokensTotal = 0;
  private outputTokensTotal = 0;
  private turnsTotal = 0;
  private lastModelName: string | null = null;
  private lastModelVendor: string | null = null;
  private lastModelFamily: string | null = null;
  private lastModelMaxInputTokens: number | null = null;
  private preferredModelId: string | null = null;

  // Listeners notified when a successful request completes — used by
  // panels to re-detect agents and refresh the displayed model name.
  private firstSuccessListeners: Array<() => void> = [];
  private hadFirstSuccess = false;

  // Serial queue for output chunks. Fire-and-forget parallel POSTs race
  // at the Redis stream and can cause the client to see `done:true`
  // before the last `done:false` streaming chunk — which spawns a
  // phantom second bubble with a lingering typing indicator. Chaining
  // the pushes preserves CLI-compatible ordering.
  private pushQueue: Promise<unknown> = Promise.resolve();

  private constructor(log: OutputChannel) {
    this.log = log;
  }

  static initialize(log: OutputChannel): CopilotChatService {
    CopilotChatService.instance = new CopilotChatService(log);
    return CopilotChatService.instance;
  }

  static getInstance(): CopilotChatService {
    if (!CopilotChatService.instance) {
      throw new Error('CopilotChatService not initialized');
    }
    return CopilotChatService.instance;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const models = await vscode.lm.selectChatModels({});
      return models.length > 0;
    } catch {
      return false;
    }
  }

  async getActiveModelName(): Promise<string | null> {
    try {
      const models = await vscode.lm.selectChatModels({});
      if (models.length === 0) { return null; }
      const first = models[0];
      return `${first.vendor} · ${first.name}`;
    } catch {
      return null;
    }
  }

  /**
   * Proactively triggers the VS Code Language Model consent dialog so the
   * user can approve access right when they pair (or reconnect), rather
   * than experiencing a confusing pause on the first real prompt from
   * mobile. Fires a dummy sendRequest and cancels it as soon as the
   * response stream starts, so token consumption is negligible.
   * No-op if consent is already granted or the API is unavailable.
   */
  async primeConsent(): Promise<void> {
    if (typeof vscode.lm?.selectChatModels !== 'function') { return; }

    try {
      const already = await vscode.lm.selectChatModels({});
      if (already.length > 0) {
        this.log.appendLine('[lm] Consent already granted — skip priming');
        return;
      }
    } catch {
      // fall through — try to prime anyway
    }

    // Consent hasn't been decided. Kick off a trivial request; VS Code
    // will surface its permission dialog. We cancel immediately so no
    // tokens are consumed beyond the first round-trip.
    let models: vscode.LanguageModelChat[] = [];
    try {
      models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      if (models.length === 0) {
        models = await vscode.lm.selectChatModels({});
      }
    } catch (e) {
      this.log.appendLine(`[lm] primeConsent selectChatModels threw: ${e}`);
    }

    if (models.length === 0) {
      this.log.appendLine('[lm] primeConsent: no models available yet; consent dialog will appear on first prompt');
      return;
    }

    const cts = new vscode.CancellationTokenSource();
    try {
      this.log.appendLine(`[lm] Priming consent via ${models[0].vendor}/${models[0].name}`);
      const response = await models[0].sendRequest(
        [vscode.LanguageModelChatMessage.User('ping')],
        {},
        cts.token,
      );
      // Cancel as soon as we know consent was accepted (stream exists).
      // Don't consume the full response.
      cts.cancel();
      // Drain quickly to let the SDK settle; ignore content.
      try { for await (const _ of response.text) { break; } } catch { /* ignored */ }
      this.log.appendLine('[lm] Consent primed successfully');
    } catch (e) {
      const err = e as { message?: string; code?: string };
      if (err.code === 'NoPermissions' || /consent|permission/i.test(err.message || '')) {
        this.log.appendLine('[lm] User declined consent — will prompt again on next send');
      } else {
        this.log.appendLine(`[lm] primeConsent error: ${err.message || e}`);
      }
    } finally {
      cts.dispose();
    }
  }

  /**
   * Streams the response of a prompt as OutputChunks to the mobile client.
   * Returns true if the request completed successfully, false if Copilot is
   * unavailable, the user cancelled consent, or a stream error occurred.
   */
  async sendPrompt(prompt: string, sessionId: string, modelId?: string): Promise<boolean> {
    this.cancelActive();

    let models: vscode.LanguageModelChat[];
    try {
      // Prefer Copilot if available; fall back to any registered provider.
      models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      if (models.length === 0) {
        models = await vscode.lm.selectChatModels({});
      }
    } catch (e) {
      this.log.appendLine(`[lm] selectChatModels threw: ${e}`);
      this.pushChunk(sessionId, {
        type: 'text',
        content: '⚠️ VS Code Chat is not available',
        done: true,
      });
      return false;
    }

    if (models.length === 0) {
      this.log.appendLine('[lm] No chat models available');
      this.pushChunk(sessionId, {
        type: 'text',
        content: '⚠️ No chat models available. Sign in to GitHub Copilot or configure a language model provider in VS Code.',
        done: true,
      });
      return false;
    }

    // Pick a model: per-request modelId > persisted preferred > default[0].
    const targetId = modelId ?? this.preferredModelId ?? undefined;
    let model: vscode.LanguageModelChat;
    if (targetId) {
      const match = models.find(
        (m) => m.id === targetId || m.family === targetId || m.name === targetId,
      );
      if (match) {
        model = match;
      } else {
        this.log.appendLine(`[lm] Requested model "${targetId}" not found; using default ${models[0].name}`);
        model = models[0];
      }
    } else {
      model = models[0];
    }
    this.log.appendLine(`[copilot] Using model ${model.vendor}/${model.family} (${model.name})`);

    // Cache model metadata so getContextSnapshot can report it.
    this.lastModelName = model.name;
    this.lastModelVendor = model.vendor;
    this.lastModelFamily = model.family;
    this.lastModelMaxInputTokens = model.maxInputTokens ?? null;

    const cts = new vscode.CancellationTokenSource();
    this.activeCancel = cts;

    // Emit CLI-compatible turn-start signal. The mobile/web client
    // expects `clear` → `new_turn` before streaming text arrives; this
    // resets its streaming buffer, creates exactly one placeholder
    // bubble, and enables the typing indicator. Without these chunks,
    // the first `text` chunk lazily creates a placeholder AND any
    // out-of-order `done:true` spawns a second phantom bubble with a
    // stuck typing indicator.
    this.pushChunk(sessionId, { clear: true });
    this.pushChunk(sessionId, { type: 'new_turn', content: '', done: false });

    // Count input tokens up-front (best-effort; failing to count shouldn't block the request).
    let promptTokens = 0;
    try {
      promptTokens = await model.countTokens(prompt, cts.token);
    } catch { /* ignore */ }

    // Record the user turn in the chat history so the mobile "Sessions"
    // screen can show this conversation alongside Claude Code sessions.
    let history: ChatHistoryService | null = null;
    try { history = ChatHistoryService.getInstance(); } catch { /* not initialized */ }
    history?.addUserMessage(prompt);

    let fullResponseText = '';

    try {
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        cts.token,
      );

      // The mobile/web SSE consumer REPLACES its local text with
      // chunk.content on every text chunk (codeam-cli-style protocol
      // where each chunk is a full snapshot of the current render,
      // not a delta). So we must send the full accumulated response
      // on every flush, not the incremental fragment — otherwise every
      // chunk overwrites the previous one and only the last delta
      // survives.
      let flushTimer: NodeJS.Timeout | null = null;
      let lastFlushedLength = 0;

      const flush = () => {
        if (fullResponseText.length === lastFlushedLength) { return; }
        this.pushChunk(sessionId, {
          type: 'text',
          content: fullResponseText,
          done: false,
        });
        lastFlushedLength = fullResponseText.length;
      };

      for await (const fragment of response.text) {
        if (cts.token.isCancellationRequested) { break; }
        fullResponseText += fragment;
        if (!flushTimer) {
          flushTimer = setTimeout(() => {
            flush();
            flushTimer = null;
          }, 80);
        }
      }

      if (flushTimer) { clearTimeout(flushTimer); }
      // No explicit final flush: the `done:true` chunk below carries
      // the complete snapshot and, thanks to the serial queue, is
      // guaranteed to be the last chunk the client observes.

      // Count output tokens once we've got the full response.
      let outputTokens = 0;
      if (fullResponseText.length > 0) {
        try {
          outputTokens = await model.countTokens(fullResponseText);
        } catch { /* ignore */ }
      }

      this.turnsTotal += 1;
      this.inputTokensTotal += promptTokens;
      this.outputTokensTotal += outputTokens;

      // Record the agent turn and push updated session list to the API
      // so the mobile "Sessions" screen sees this chat.
      if (history && fullResponseText.length > 0) {
        const session = history.addAgentMessage(fullResponseText);
        history.pushSessions().catch(() => { /* silent */ });
        if (session) {
          history.pushConversation(session.id).catch(() => { /* silent */ });
        }
      }

      // Final done chunk carries the complete text so the mobile's
      // fallback `content || 'Done'` renders the real response.
      this.pushChunk(sessionId, {
        type: 'text',
        content: fullResponseText,
        done: true,
      });
      this.notifyFirstSuccess();
      return true;
    } catch (e) {
      const err = e as { message?: string; code?: string };
      // Consent denied or quota exceeded → surface to mobile user.
      this.log.appendLine(`[copilot] sendRequest error: ${err.message || e}`);
      const friendly =
        err.code === 'NoPermissions' || /consent/i.test(err.message || '')
          ? 'Copilot consent required. Approve the request in VS Code and retry.'
          : err.code === 'Blocked'
            ? 'Copilot blocked the request due to content policy.'
            : err.message || 'Copilot request failed';
      // Mobile replaces bubble text with each chunk, so keep whatever
      // partial response we had and append the error on a new line if
      // we were already mid-stream — otherwise just show the error.
      const finalText = fullResponseText.length > 0
        ? `${fullResponseText}\n\n⚠️ ${friendly}`
        : `⚠️ ${friendly}`;
      this.pushChunk(sessionId, { type: 'text', content: finalText, done: true });
      return false;
    } finally {
      if (this.activeCancel === cts) { this.activeCancel = null; }
      cts.dispose();
    }
  }

  /**
   * Emits the CLI-compatible resume signal so the mobile/web client
   * clears its current thread and refetches the conversation for
   * `resumedSessionId` via `/api/sessions/claude-conversation`. The
   * caller must have already posted the conversation to that endpoint
   * (via `ChatHistoryService.pushConversation`) so the fetch returns
   * the expected messages.
   */
  emitResumeSignal(sessionId: string, resumedSessionId: string): void {
    this.pushChunk(sessionId, { clear: true });
    this.pushChunk(sessionId, {
      type: 'new_turn',
      resumedSessionId,
      content: '',
      done: false,
    });
  }

  /**
   * Returns the shape the mobile app already expects from `get_context`
   * (same keys as the codeam-cli response). Copilot doesn't expose usage
   * quotas, so `used`/`total`/`percent` are zero with a friendly error
   * string; model and output-token counters are populated from live state.
   */
  async getContextSnapshot(): Promise<LmContextSnapshot> {
    let model: vscode.LanguageModelChat | null = null;
    try {
      const primary = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      model = primary[0] ?? (await vscode.lm.selectChatModels({}))[0] ?? null;
    } catch {
      /* fall through */
    }

    if (model) {
      this.lastModelName = model.name;
      this.lastModelVendor = model.vendor;
      this.lastModelFamily = model.family;
      this.lastModelMaxInputTokens = model.maxInputTokens ?? null;
    }

    const name = this.lastModelName;
    // If we know the model's context window, use inputTokens / maxInputTokens
    // as a crude "context used" signal so the UI's quota bar shows something.
    const total = this.lastModelMaxInputTokens ?? 0;
    const used = total > 0 ? Math.min(this.inputTokensTotal, total) : 0;
    const percent = total > 0 ? Number(((used / total) * 100).toFixed(1)) : 0;

    return {
      used,
      total,
      percent,
      model: name,
      outputTokens: this.outputTokensTotal,
      cacheReadTokens: 0,
      monthlyCost: 0,
      provider: this.lastModelVendor ?? 'copilot',
      modelFamily: this.lastModelFamily ?? undefined,
      error: total > 0 ? undefined : 'Usage stats not exposed by VS Code Chat',
    };
  }

  onFirstSuccess(cb: () => void): void {
    if (this.hadFirstSuccess) {
      // Already happened — notify immediately.
      try { cb(); } catch { /* ignore */ }
      return;
    }
    this.firstSuccessListeners.push(cb);
  }

  resetSessionCounters(): void {
    this.inputTokensTotal = 0;
    this.outputTokensTotal = 0;
    this.turnsTotal = 0;
  }

  setPreferredModel(modelId: string | null): void {
    this.preferredModelId = modelId;
    this.log.appendLine(`[lm] Preferred model set to: ${modelId ?? '<default>'}`);
  }

  getPreferredModel(): string | null {
    return this.preferredModelId;
  }

  /**
   * Returns every chat model the VS Code LM API can see. Each entry mirrors
   * the shape the mobile model picker expects (codeam-cli returns the
   * same).
   */
  async listAvailableModels(): Promise<Array<{
    id: string;
    label: string;
    description?: string;
    family: string;
    vendor: string;
    maxInputTokens?: number;
    isDefault?: boolean;
  }>> {
    if (typeof vscode.lm?.selectChatModels !== 'function') { return []; }

    let all: vscode.LanguageModelChat[] = [];
    try {
      const copilot = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      const generic = await vscode.lm.selectChatModels({});
      // Dedupe: keep the first occurrence of each id.
      const seen = new Set<string>();
      for (const m of [...copilot, ...generic]) {
        if (seen.has(m.id)) { continue; }
        seen.add(m.id);
        all.push(m);
      }
    } catch (e) {
      this.log.appendLine(`[lm] listAvailableModels threw: ${e}`);
      return [];
    }

    const preferred = this.preferredModelId;
    return all.map((m) => ({
      id: m.id,
      label: m.name,
      description: `${m.vendor} · ${m.family}`,
      family: m.family,
      vendor: m.vendor,
      maxInputTokens: m.maxInputTokens,
      isDefault: preferred ? m.id === preferred : false,
    }));
  }

  private notifyFirstSuccess(): void {
    if (this.hadFirstSuccess) { return; }
    this.hadFirstSuccess = true;
    const listeners = [...this.firstSuccessListeners];
    this.firstSuccessListeners = [];
    for (const cb of listeners) {
      try { cb(); } catch (e) { this.log.appendLine(`[lm] firstSuccess listener error: ${e}`); }
    }
  }

  cancelActive(): void {
    if (this.activeCancel) {
      this.log.appendLine('[copilot] Cancelling active request');
      this.activeCancel.cancel();
      this.activeCancel = null;
    }
  }

  /**
   * Append an arbitrary output chunk to the serial push queue. Accepts
   * the same shape the CLI uses (e.g. `{ clear: true }`,
   * `{ type: 'new_turn', resumedSessionId, ... }`,
   * `{ type: 'text', content, done }`) so the mobile client sees an
   * identical SSE stream regardless of whether it's paired with the
   * CLI or the VS Code extension.
   */
  private pushChunk(sessionId: string, body: Record<string, unknown>): void {
    const settings = SettingsService.getInstance();
    const relay = CommandRelayService.getInstance();
    const pluginId = settings.ensurePluginId();
    this.pushQueue = this.pushQueue
      .then(() =>
        relay.postJson(`${settings.apiBaseUrl}/api/commands/output`, {
          sessionId,
          pluginId,
          ...body,
        }),
      )
      .catch((e) => {
        this.log.appendLine(`[copilot] Failed to push output: ${e}`);
      });
  }
}
