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
  // `show_install_command` — backend pushes the self-hosted install
  // one-liner the user copies onto their own box. DISPLAY-ONLY: the
  // CLI prints it to the terminal and never executes it. Bounded to
  // 8192 chars so a malformed payload can't flood the terminal.
  command: z.string().min(1).max(8192).optional(),
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
  action: z
    .enum([
      'approved',
      'rejected',
      'enable',
      'disable',
      'status',
      // `coderabbit_configure` — link the reviewer (OAuth or API key) + run a review.
      'link_oauth',
      'link_apikey',
      'review',
    ])
    .optional(),
  // `headroom_configure` — savings ingest URL delivered from the session
  // when enabling Headroom on-demand. Bounded to 2048 chars.
  savingsIngestUrl: z.string().url().max(2048).optional(),
  // `coderabbit_configure` (action='link_apikey') — the CodeRabbit API key.
  apiKey: z.string().min(1).max(512).optional(),
  // `coderabbit_configure` (action='review') — review scope, mirroring the
  // CLI's `--type` / `--base` / `--dir`.
  changeSet: z.enum(['all', 'committed', 'uncommitted']).optional(),
  base: z.string().max(255).optional(),
  reviewDir: z.string().max(1024).optional(),
  // `request_link_credentials` — backend fires this from the
  // heartbeat handler when it notices the user is running an agent
  // they haven't vaulted yet. Also reused by `get_context` /
  // `list_models` payloads which carry the currently-selected
  // agent for that session. We accept any string here (rather than
  // a narrow enum) because the web sends internal ids ('claude')
  // while the auto-link backend sends public ids ('claude_code'),
  // and the consuming handlers normalize themselves.
  //
  // `.nullable()` — the web's session page passes the literal value
  // `null` when no agent has been selected yet for the session
  // (`currentAgentId` is null before sessionAgents populates).
  // Without nullable() zod rejects the whole payload, the dispatcher
  // logs "Ignoring malformed list_models payload" and the model
  // picker / context never load.
  agentId: z.string().max(64).nullable().optional(),
  // `request_ai_summary` / `request_ai_insight` — backend fires
  // these on turn-end (+ file selection) when LinkedAgent.
  // aiInsightsEnabled is true. The CLI spawns the agent in
  // headless one-shot mode (`claude -p "..."` / `codex exec`) and
  // POSTs the response back to /api/plugin/ai-result.
  //
  // `prompt` (declared above for start_task) carries the LLM prompt
  // the backend pre-rendered with the diff context inlined; the
  // agent receives it verbatim. `turnId` keys the summary,
  // `fileChangeId` keys the per-file insight, `stats` is echoed
  // unchanged on the result POST so the backend doesn't have to
  // recompute (numbers came from file_changes; the agent only
  // writes the narrative).
  turnId: z.string().max(128).optional(),
  fileChangeId: z.string().max(128).optional(),
  stats: z
    .object({
      added: z.number().int(),
      removed: z.number().int(),
      complexityShift: z.number().int(),
    })
    .optional(),
  // `preview_start` carries the agent-detected `PreviewDetection`
  // shape from the mobile / web confirmation sheet. Mirrors
  // `@codeam/shared`'s `PreviewDetection` byte-for-byte. Kept
  // loose (`unknown` for env / setup_commands) so a CLI version
  // running against a newer backend that adds optional fields still
  // accepts the payload; the handler validates the shape it needs
  // before spawning.
  detection: z
    .object({
      framework: z.string().max(64),
      command: z.string().min(1).max(256),
      args: z.array(z.string().max(1024)).max(64),
      port: z.number().int().min(1).max(65535),
      ready_pattern: z.string().min(1).max(4096),
      env: z.record(z.string(), z.string().max(8192)).optional(),
      // The agent emits entries as either {cmd,args} objects OR bare command
      // strings ("npx prisma generate"). Accept both and normalize strings to
      // {cmd,args} so a string entry doesn't reject the whole detection (which
      // would silently drop the preview) and downstream always gets objects.
      setup_commands: z
        .array(
          z
            .union([
              z.string().min(1).max(1024),
              z.object({
                cmd: z.string().min(1).max(256),
                args: z.array(z.string().max(1024)).max(64),
              }),
            ])
            .transform((entry) => {
              if (typeof entry !== 'string') return entry;
              const parts = entry.trim().split(/\s+/).filter(Boolean);
              return { cmd: parts[0] ?? '', args: parts.slice(1) };
            }),
        )
        .max(32)
        .optional(),
      notes: z.string().max(4096).nullable().optional(),
    })
    .optional(),
  // `env_write` carries the full desired set of environment variables
  // for the project `.env`. Bounded so a malformed payload can't flood
  // the disk-side serializer. `env_read` / `preview_restart` send no payload.
  vars: z
    .array(
      z.object({
        key: z.string().min(1).max(256),
        value: z.string().max(32768),
      }),
    )
    .max(512)
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
