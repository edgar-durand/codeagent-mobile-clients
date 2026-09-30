# Plugin directory submission sheet

Everything the OpenAI plugin portal (`platform.openai.com/plugins`) asks for that is not inside the ZIP.
The ZIP comes from `npm run plugin:pack` (`dist/codeagent-mobile-plugin-<version>.zip`).
Reviewer credentials are entered only in the portal's Review details, never in this file.

## Review details

- Login URL: `https://www.codeagent-mobile.com/login`
- Account: the dedicated review account (email + password in the portal only). Email is pre-verified, no MFA, no magic link.
- Workspace / tenant: none.
- Sign-in: connect the plugin, sign in with the review account on the CodeAgent Mobile page, press Allow on the consent screen.
- Sample data: the account has one CodeAgent Box session with a small demo project and the house managed agent. It has no phone registered and no GitHub repository linked.

## Positive test cases

| # | description | prompt | tools_triggered | expected_behavior |
|---|---|---|---|---|
| 1 | List the user's coding sessions | Show me my running CodeAgent sessions | `list_sessions` | One CodeAgent Box session is listed with its agent and status (idle). |
| 2 | Start a task on a session | Start a task on my CodeAgent Box: add a README with the project name | `list_sessions`, `start_task` | The task is accepted and the reply names the session and the command id. |
| 3 | Check progress | What is the agent doing on my Box right now? | `get_session` | The reply gives the session status (running or idle) and a summary of the latest agent turn. |
| 4 | Review the changes | Show me what changed in that session | `get_diff` | A per-file summary of the working-tree changes, including README.md. |
| 5 | Switch to a managed agent with confirmation | Continue this session with a CodeAgent managed agent | `list_agents`, `get_wallet_balance`, `switch_agent` | The model shows the credit balance and asks the user to confirm before switching; after "yes" the switch is accepted. |

## Negative test cases

| # | description | prompt |
|---|---|---|
| 1 | Unrelated request must not call the plugin | What's a good recipe for banana bread? |
| 2 | Deploy is out of scope; the plugin must not claim to deploy | Deploy my app to production from here |
| 3 | Pull request without a GitHub repository is refused with an explanation | Create a pull request from my CodeAgent Box session |

Expected for negative 3: `create_pull_request` returns an error because the scratch project has no GitHub repository; the model explains that and suggests saving the project to GitHub from the app.

## Demo video

`demo_recording_url`: a reviewer-accessible link (unlisted YouTube or a public file URL) showing positive cases 1–5 in ChatGPT with the CodeAgent Mobile app on screen for the handoff. Record it after the review account is set up.
