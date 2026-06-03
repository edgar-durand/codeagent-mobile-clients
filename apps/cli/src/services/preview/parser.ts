import type { PreviewDetection } from '@codeagent/shared';

const REQUIRED_FIELDS: Array<keyof PreviewDetection> = [
  'framework',
  'command',
  'args',
  'port',
  'ready_pattern',
];

/**
 * Parse the agent's headless-mode stdout into a {@link PreviewDetection}.
 * Returns `null` when the output isn't valid JSON or is missing one of
 * the required fields. The CLI handler turns a null into a
 * `preview_error` event with `stage: 'detection'` so the mobile / web
 * card can surface the failure with a Retry action.
 *
 * Strips a single layer of markdown fences in case the agent ignored
 * the "NO MARKDOWN" instruction in the prompt — common with Codex.
 */
export function safeParseDetection(raw: string | null): PreviewDetection | null {
  if (!raw) return null;
  const stripped = raw
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) return null;
  }
  return obj as unknown as PreviewDetection;
}

const CLOUDFLARED_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** Extract the `https://*.trycloudflare.com` URL from cloudflared stderr. */
export function parseCloudflaredUrl(stderr: string): string | null {
  const match = stderr.match(CLOUDFLARED_URL_RE);
  return match ? match[0] : null;
}

const EXPO_URL_RE = /exp:\/\/[^\s]+\.exp\.host/;

/** Extract the `exp://*.exp.host` deep link from Expo's stdout. */
export function parseExpoUrl(stdout: string): string | null {
  const match = stdout.match(EXPO_URL_RE);
  return match ? match[0] : null;
}
