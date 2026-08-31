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
  const parsed = parseDetectionObject(raw);
  if (!parsed) return null;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in parsed)) return null;
  }
  return parsed as unknown as PreviewDetection;
}

/**
 * Las tres pasadas de parseo, sin la validacion de campos.
 *
 * Compartido con `describeDetectionFailure` A PROPOSITO: si el diagnostico
 * usara su propio parseo podria discrepar de la decision real y explicar un
 * fallo que no ocurrio.
 */
function parseDetectionObject(raw: string): Record<string, unknown> | null {
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

  return (parsed as Record<string, unknown> | null) ?? null;
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

/** Por que no salio una deteccion utilizable. Cada motivo tiene otro arreglo. */
export type DetectionFailureReason = 'no_output' | 'no_json' | 'missing_fields';

export interface DetectionFailure {
  reason: DetectionFailureReason;
  /** Frase honesta para el usuario. NUNCA culpa al JSON si no hubo JSON. */
  message: string;
  /** Solo en `missing_fields`: que campos faltan. Es lo unico accionable. */
  missing?: string[];
  /** La salida cruda, ACOTADA, para el log de depuracion local. */
  rawExcerpt: string;
}

/** Tope del extracto. Un one-shot puede devolver miles de lineas y el log
 *  vive en la maquina del usuario: no es sitio para volcarlas enteras. */
const RAW_EXCERPT_LIMIT = 1_000;

/**
 * Nombra por que fallo la deteccion — `null` si en realidad no fallo.
 *
 * codeagent-k9q4. Hasta ahora un fallo de deteccion solo dejaba
 * `detect: invalid agent output after 4210ms`, sin la salida, asi que era
 * imposible distinguir tres cosas con arreglos distintos: el agente devolvio
 * prosa, devolvio JSON al que le faltan campos, o no devolvio NADA.
 *
 * El caso que lo pide (2026-08-30): un usuario encadeno CINCO fallos de
 * deteccion en 19 minutos, ningun exito, y se fue. No se puede arreglar lo que
 * no se puede nombrar.
 *
 * Y el mensaje al usuario decia "Agent returned invalid JSON" en los tres
 * casos — mentira cuando el agente no contesto, porque manda a mirar un JSON
 * que no existe.
 */
export function describeDetectionFailure(raw: string | null): DetectionFailure | null {
  const text = raw?.trim() ?? '';
  const rawExcerpt = text.slice(0, RAW_EXCERPT_LIMIT);

  if (!text) {
    return {
      reason: 'no_output',
      message:
        "The agent didn't return anything for this project. Try again, or add a .codeam/preview.json override.",
      rawExcerpt,
    };
  }

  // Se reusa el mismo camino de parseo que `safeParseDetection` para que el
  // diagnostico no pueda discrepar de la decision real.
  const parsed = parseDetectionObject(text);
  if (!parsed) {
    return {
      reason: 'no_json',
      message:
        'The agent replied without a JSON block. Try again, or add a .codeam/preview.json override.',
      rawExcerpt,
    };
  }

  const missing = REQUIRED_FIELDS.filter((f) => !(f in parsed)).map(String);
  if (missing.length > 0) {
    return {
      reason: 'missing_fields',
      // Decir CUALES: es lo unico con lo que alguien puede escribir el
      // override a mano y desbloquearse sin esperar a nadie.
      message: `The agent's answer is missing ${missing.join(', ')}. Try again, or add a .codeam/preview.json override.`,
      missing,
      rawExcerpt,
    };
  }
  return null;
}
