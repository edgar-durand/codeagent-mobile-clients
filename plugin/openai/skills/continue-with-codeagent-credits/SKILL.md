---
name: continue-with-codeagent-credits
description: Switch a session to a CodeAgent managed agent billed from the user's prepaid credits, with the user's explicit confirmation.
---

# Continue with CodeAgent credits

Use when the user asks to run or continue with a CodeAgent managed agent, or when their linked agent is unavailable (`list_agents` shows `credential_status: expired`).

## Workflow
1. Call `list_agents` and `get_wallet_balance`.
2. Show the user: the managed agents available, and the balance in USD. Say plainly that a managed agent consumes credits.
3. Ask the user to confirm switching, naming the agent. Wait for a clear yes.
4. Only after that yes, call `switch_agent` with `confirm_wallet_use: true`. If the tool answers `CONFIRMATION_REQUIRED`, you skipped step 3 — show the balance it returned and ask again. If it answers `INSUFFICIENT_BALANCE`, tell the user to top up in the CodeAgent app; do not retry.
5. Confirm the switch and continue with `supervise-session`.

Never set `confirm_wallet_use: true` without the user's explicit confirmation in this conversation.
