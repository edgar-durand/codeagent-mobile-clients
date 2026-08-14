/**
 * Builds the ACP `prompt` content-block array from a `start_task`
 * payload. Pure / synchronous — extracted from the runner so the
 * image-attachment contract (QA Android #290) can be pinned by a
 * vitest unit instead of an integration test that spins up the SDK.
 *
 * Block ordering matches what every adapter we ship today expects:
 * image blocks first (so the agent reads visual context before the
 * instruction), text last. Each `ContentBlock['image']` carries
 * base64-encoded bytes + a mimeType; files that arrive without
 * base64 data are skipped defensively so a malformed payload never
 * blocks the whole turn.
 */

export interface FileEntry {
  filename: string;
  /** Base64-encoded body. Empty / missing → file is skipped. */
  base64?: string;
  /** MIME type. When absent we infer from the file extension. */
  mimeType?: string;
}

export interface StartTaskPayload {
  prompt?: string;
  files?: FileEntry[];
}

/**
 * The subset of the ACP `ContentBlock` union this CLI ever SENDS.
 *
 * `resource` is an `EmbeddedResource` (`{ type: 'resource', resource: { uri,
 * mimeType, text } }` — structurally the SDK's `EmbeddedResource &
 * { type: 'resource' }` over `TextResourceContents`). It carries injected
 * CONTEXT rather than user words, so conforming agents keep it out of the
 * transcript's user message — see `squad-context.ts` for why that matters.
 * Blocks are handed to `connection.prompt({ prompt: blocks })` verbatim, so
 * this union IS the wire shape; no separate serializer exists.
 */
export type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; text: string } };

const MIME_FROM_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};

function inferMime(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return MIME_FROM_EXT[ext] ?? 'application/octet-stream';
}

const PLACEHOLDER_PROMPT = 'Please review the attached image(s) and let me know what you find.';

export function buildAcpPromptBlocks(payload: StartTaskPayload): PromptBlock[] {
  const blocks: PromptBlock[] = [];

  for (const file of payload.files ?? []) {
    if (!file.base64 || file.base64.length === 0) continue;
    blocks.push({
      type: 'image',
      mimeType: file.mimeType ?? inferMime(file.filename),
      data: file.base64,
    });
  }

  const text = (payload.prompt ?? '').trim();
  if (text.length > 0) {
    blocks.push({ type: 'text', text });
  } else if (blocks.length > 0) {
    blocks.push({ type: 'text', text: PLACEHOLDER_PROMPT });
  }

  return blocks;
}
