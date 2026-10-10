/**
 * Wire types for the Smart Composer LLM service.
 * The mobile and web clients call POST /api/composer/structure with a
 * ComposerStructureRequest and consume a stream of ComposerStructureStreamEvent
 * over SSE. Attachments carry metadata only — never base64 — so the LLM
 * input stays bounded.
 *
 * Owned here since 2026-10-09 (epic codeagent-pi6): api-v2, mobile and web
 * import these instead of keeping hand-synced copies.
 */

export interface ComposerAttachmentMeta {
  filename: string;
  mime: string;
  sizeBytes: number;
  /** Pixel width, only for images. */
  width?: number;
  /** Pixel height, only for images. */
  height?: number;
  /**
   * Improvement A (Unified Voice Command Phase 1) — for text attachments
   * (logs, code, etc.) the client sends a bounded excerpt of the file's
   * text content so the LLM can actually read it. Never set for images —
   * those are referenced by filename only (never base64) so the payload
   * stays bounded and the structured CONTEXT chips can still show them.
   */
  textExcerpt?: string;
}

export interface ComposerSessionContext {
  sessionId: string;
  /** Agent id from the paired session, e.g. 'claude-code', 'codex'. */
  agentId: string;
  /** Active model id, if known. Null when the agent hasn't reported one. */
  modelId: string | null;
  /** Up to 5 recent message ids from the current conversation, oldest first. */
  lastMessageIds: string[];
  /** Reserved for Eje B feature #5 (Saved Context Profiles). Always undefined in v1. */
  activeContextProfileId?: string | null;
}

export interface ComposerStructureRequest {
  voiceTranscript: string;
  attachments: ComposerAttachmentMeta[];
  sessionContext: ComposerSessionContext;
  /** When true, the LLM also emits a 2–4 word title in its response. Sent only on the first prompt of a new conversation. */
  requestAutoTitle: boolean;
}

export type ComposerErrorCode = 'rate_limited' | 'llm_error' | 'invalid_input';

export type ComposerStructureStreamEvent =
  | { event: 'meta'; data: { cacheHit: boolean; modelId: string } }
  | { event: 'prompt-chunk'; data: { text: string } }
  | { event: 'auto-title'; data: { title: string } }
  | { event: 'done'; data: { tokensIn: number; tokensOut: number; latencyMs: number } }
  | { event: 'error'; data: { code: ComposerErrorCode; message: string } };
