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
  // Mini-IDE / project ops. `paths` (plural, strings) is used for
  // git_commit's optional file selection — distinct from `files`
  // (FileEntry[]) used by `start_task` for attachments.
  query: z.string().max(256).optional(),
  message: z.string().max(8000).optional(),
  paths: z.array(z.string().max(4096)).optional(),
  side: z.enum(['ours', 'theirs']).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  // search_files options. `query` is the haystack/needle string,
  // declared above for list_files. The rest mirror VS Code's
  // search panel toggles + the @codeam/ide-core SearchOptions
  // contract.
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  regex: z.boolean().optional(),
  include: z.array(z.string().max(512)).max(64).optional(),
  exclude: z.array(z.string().max(512)).max(64).optional(),
  maxResults: z.number().int().min(1).max(500).optional(),
  // terminal_open / _write / _resize / _close. `sessionId` is the
  // opaque uuid returned by `terminal_open` and required by every
  // subsequent op. `data` carries keystrokes (any UTF-8 string).
  // `cwd` lets the host pin the spawn directory.
  sessionId: z.string().min(1).max(128).optional(),
  data: z.string().max(64 * 1024).optional(),
  cwd: z.string().max(4096).optional(),
  cols: z.number().int().min(1).max(500).optional(),
  rows: z.number().int().min(1).max(200).optional(),
  // `apply_file_review` (Epic B follow-up — backend pushes this when
  // the user clicks APPROVE_CHANGES / REJECT_CHANGES in the diff
  // drawer). `filePath` is relative to the enclosing git repo; the
  // handler walks up from it to find `.git/` and runs `git add` or
  // `git restore` from there. `action='approved'` stages the edit,
  // `action='rejected'` discards every worktree change on the file.
  filePath: z.string().min(1).max(4096).optional(),
  action: z.enum(['approved', 'rejected']).optional(),
  // `request_link_credentials` — backend fires this from the
  // heartbeat handler when it notices the user is running an agent
  // they haven't vaulted yet. We reuse the `codeam link` token-
  // capture path to push the credential up; if extraction fails
  // (no local auth, missing file), the handler no-ops silently —
  // no browser-login surprises during a normal `codeam pair`.
  agentId: z
    .enum(['claude_code', 'codex', 'cursor', 'aider', 'coderabbit'])
    .optional(),
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
