---
name: start-coding-task
description: Start a CodeAgent coding task from the user's request on one of their existing sessions, and report the session id so they can follow it.
---

# Start a coding task

Use this when the user asks to have an agent do coding work ("fix…", "implement…", "add tests for…", "solve issue #…").

## Workflow
1. Call `list_sessions`. If the user named a repository, project or host, pick the session whose `repository` or `title` matches. If none matches, or more than one could, **ask the user which session** — never guess.
2. If the chosen session is `offline`, tell the user the host is offline; `start_task` will try to wake a codespace or CodeAgent Box, but a local CLI must be started by the user.
3. If the user asked for a specific agent, call `list_agents` and pass its `id` as `agent_id`. If that agent is `managed` (uses credits), follow the `continue-with-codeagent-credits` skill first.
4. Call `start_task` with a clear, self-contained `task` (include the issue number and any acceptance criteria the user gave). For a GitHub issue, describe it in the task text; the agent reads the repository itself.
5. Reply in three lines: what was started, on which session (`title`, `session_id`), and that you will report progress on request. Example:
   ```
   Started Claude Code on org/app (session cmt…): "Fix checkout validation".
   Status: running. Ask me "what's the agent doing?" for an update.
   ```
6. Never say the work is done. `start_task` only accepts the task; completion is only visible through `get_session` (status `idle` with new changes) or `get_diff`.
