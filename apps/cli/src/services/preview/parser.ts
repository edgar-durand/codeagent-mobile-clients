import type { PreviewDetection } from '@codeam/shared';

const REQUIRED_FIELDS: Array<keyof PreviewDetection> = [
  'framework',
  'command',
  'args',
  'port',
  'ready_pattern',
];

/**
 * Parse the agent's headless-mode stdout into a {@link PreviewDetection}.
 * Returns `null` when no parseable JSON object can be extracted or
 * required fields are missing. The CLI handler turns a null into a
 * `preview_error` event with `stage: 'detection'` so the mobile / web
 * card can surface the failure with a Retry action.
 *
 * Tolerates four common agent output shapes (in order of preference):
 *   1. Pure JSON — `{"framework":...}`
 *   2. Markdown-fenced — ```` ```json\n{...}\n``` ````
 *   3. JSON embedded in prose — "Here is the detection:\n{...}\nDone."
 *   4. Whitespace + JSON
 *
 * The shape-validation pass at the end checks every REQUIRED_FIELDS
 * entry, so a malformed JSON that happens to parse still fails fast.
 */
export function safeParseDetection(raw: string | null): PreviewDetection | null {
  if (!raw) return null;

  // Pass 1: try the whole input first (covers cases 1 + 4).
  let parsed = tryParseObject(raw.trim());

  // Pass 2: strip a single layer of markdown fences (case 2).
  if (!parsed) {
    const stripped = raw
      .replace(/^```(?:json)?\s*/m, '')
      .replace(/\s*```\s*$/m, '')
      .trim();
    if (stripped !== raw.trim()) {
      parsed = tryParseObject(stripped);
    }
  }

  // Pass 3: extract the first balanced `{...}` block from anywhere in
  // the output (case 3 — agent wrapped the JSON in prose). Walks the
  // string tracking brace depth so a JSON value containing nested
  // braces parses correctly. Skips brace characters inside JSON
  // string literals.
  if (!parsed) {
    const candidate = extractFirstJsonObject(raw);
    if (candidate) parsed = tryParseObject(candidate);
  }

  if (!parsed) return null;
  const obj = parsed as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) return null;
  }
  return obj as unknown as PreviewDetection;
}

function tryParseObject(s: string): unknown | null {
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v !== null ? v : null;
  } catch {
    return null;
  }
}

/**
 * Walks `s` and returns the first balanced `{…}` substring, or null
 * if none. Tracks brace depth while honouring JSON string literals
 * (a `{` inside a quoted string doesn't count as opening a new
 * block). Backslash escapes inside strings advance past the next
 * character so an embedded `\"` doesn't terminate the string early.
 */
function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
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
