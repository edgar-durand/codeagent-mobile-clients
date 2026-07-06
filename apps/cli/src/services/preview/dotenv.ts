import type { EnvVar } from '@codeam/shared';

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse a `.env` file body into ordered key/value pairs. Ignores blank
 * lines and `#` comments, strips an optional `export ` prefix, unquotes
 * single/double-quoted values (decoding `\n` inside double quotes), keeps
 * `=` characters inside the value, and last-wins on duplicate keys while
 * preserving first-seen order.
 */
export function parseDotenv(raw: string): EnvVar[] {
  const order: string[] = [];
  const map = new Map<string, string>();
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue; // no key, or `=value` with empty key → skip
    const key = body.slice(0, eq).trim();
    if (!ENV_KEY_RE.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    value = unquote(value);
    if (!map.has(key)) order.push(key);
    map.set(key, value);
  }
  return order.map((key) => ({ key, value: map.get(key) as string }));
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Serialize ordered key/value pairs back into a `.env` body. Always
 * emits a `# Managed by CodeAgent` header and a trailing newline.
 * Values containing whitespace, `#`, `=` or a newline are double-quoted
 * (newlines encoded as `\n`); everything else is written bare.
 */
export function serializeDotenv(vars: EnvVar[]): string {
  const lines = vars.map(({ key, value }) => `${key}=${quoteIfNeeded(value)}`);
  return `# Managed by CodeAgent\n${lines.join('\n')}${lines.length ? '\n' : ''}`;
}

function quoteIfNeeded(value: string): string {
  if (/[\s#=]/.test(value) || value.includes('\n')) {
    return `"${value.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return value;
}
