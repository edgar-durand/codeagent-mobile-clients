---
name: review-agent-work
description: Review the changes a CodeAgent session made, and open or review a pull request when the user asks.
---

# Review agent work

## Workflow
1. Resolve the session (`list_sessions`, ask if ambiguous) and call `get_diff` without a path: summarise files changed and the additions/deletions.
2. For detail, call `get_diff` with `path` for one file (hunks), or `include_patch: true` for the raw patch; if `truncated` is true, say so and go file by file.
3. Summarise: intent of the change, key implementation points, risks (tests touched? migrations? config?). Do not approve or merge anything yourself.
4. Only when the user explicitly asks, call `create_pull_request` with a concise title and a body that lists the changes. Report number, branch and URL. If the result is `PR_ALREADY_EXISTS`, give the existing URL.
5. For "review PR #N", call `review_pull_request` with `repository` (owner/repo) and `number`; tell the user findings will appear on the PR.
6. For "send this to my phone", call `send_session_to_mobile` with an optional one-line note.
