---
name: supervise-session
description: Monitor, redirect, answer or stop an existing CodeAgent session.
---

# Supervise a session

Use this for "what is the agent doing", "tell it to…", "answer yes", "stop it".

## Workflow
1. Resolve the session with `list_sessions` (filter `running` or `needs_input` when the user talks about an active agent). Ask when ambiguous.
2. Call `get_session` and summarise in at most four lines: status, latest turn, whether the agent is waiting on a question, changed-file count and PR if any.
3. If `needs_input` is true, show the `pending_question` text (and options) to the user and wait for their answer. Then call `answer_question` with `option_index` for a listed option or `answer` for free text. Never answer on the user's behalf.
4. For a new direction, call `send_instruction` with the user's words made specific ("Focus on the failing tests in checkout.spec.ts first").
5. For "stop", call `stop_task` and tell the user history and changes are kept.
6. Status words: `running` = agent working; `needs_input` = waiting for the user; `idle` = finished or waiting for a task; `offline` = host not connected.
