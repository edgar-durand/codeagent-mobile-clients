import { z } from 'zod';

/**
 * File attachment shape mirrors `FileAttachment` in apps/cli/src/commands/start.ts
 * (which itself mirrors `packages/shared/src/types/agent.ts`). The CLI receives
 * these from the backend on `start_task` commands, decodes the base64, and
 * stages the bytes as temp files for Claude Code to consume via `@path` refs.
 *
 * `name` is intentionally renamed to `filename` and bounded to 256 chars to
 * defang path-style payloads — `saveFilesTemp` already sanitizes, but a tight
 * upper bound at the parser keeps malformed inputs out of the rest of the pipeline.
 */
export const fileEntrySchema = z.object({
  filename: z.string().min(1).max(256),
  mimeType: z.string(),
  base64: z.string(),
});

export type FileEntry = z.infer<typeof fileEntrySchema>;

/**
 * Schema for the `payload` carried by every `RemoteCommand` / `agent_command`
 * the CLI consumes in `start.ts`. Every field is optional because the same
 * payload shape is reused across `start_task`, `provide_input`, `select_option`,
 * `resume_session`, etc. — each handler picks the fields it cares about.
 *
 * `name` (used in some test specs) is intentionally NOT included: the real
 * code uses `filename`/`mimeType`/`base64`. Keep the schema narrow.
 */
export const startCommandSchema = z.object({
  prompt: z.string().optional(),
  files: z.array(fileEntrySchema).optional(),
  input: z.string().optional(),
  index: z.number().optional(),
  from: z.number().optional(),
  id: z.string().optional(),
  auto: z.boolean().optional(),
  // `read_file` / `write_file` for the mobile + landing mini-IDE modal.
  // `path` is bounded to 4096 chars (a comfortable POSIX path max) so a
  // malformed payload can't blow up the disk-side validator.
  path: z.string().min(1).max(4096).optional(),
  content: z.string().optional(),
});

export type StartCommandPayload = z.infer<typeof startCommandSchema>;

/**
 * Validate an incoming command payload against a zod schema.
 * Returns the parsed (and narrowed) value on success, `null` on failure.
 *
 * Use this at every payload consumer in place of `as string | undefined` and
 * friends. If the schema rejects, the caller should bail out cleanly rather
 * than crash mid-execution on a downstream type error.
 */
export function parsePayload<T extends z.ZodTypeAny>(
  schema: T,
  raw: unknown,
): z.infer<T> | null {
  const result = schema.safeParse(raw);
  return result.success ? result.data : null;
}
