import { z } from 'zod';

/**
 * The command envelope clients receive from the backend relay — both from
 * the `commands` SSE frames on `/api/commands/pending/stream` and from the
 * `GET /api/commands/pending` polling fallback. One schema, shared, so the
 * VS Code extension (and eventually the CLI) stop blind-casting
 * `Record<string, unknown>` into this shape.
 */
export interface RemoteCommand {
  id: string;
  sessionId: string;
  pluginId: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  createdAt: number;
}

const remoteCommandSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  pluginId: z.string(),
  type: z.string(),
  // The backend may omit `payload` (or send null) for payload-less commands;
  // clients have always normalized that to `{}` — keep that behavior here.
  payload: z.record(z.string(), z.unknown()).nullish(),
  status: z.string(),
  createdAt: z.number(),
});

/**
 * Validate a raw (already JSON-parsed) value into a `RemoteCommand`.
 * Returns `null` — never throws — on a malformed envelope so callers can
 * log-and-skip the single bad command without dropping the whole batch.
 */
export function toRemoteCommand(raw: unknown): RemoteCommand | null {
  const parsed = remoteCommandSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { payload, ...rest } = parsed.data;
  return { ...rest, payload: payload ?? {} };
}
