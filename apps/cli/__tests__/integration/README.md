# CLI integration tests

These are **gated, real-world** integration tests. Each self-skips unless its
`RUN_*_INT` gate is set, so the default `npm test` (and normal CI) never runs
them — they need real binaries / network / live credentials.

| File | Gate | What it exercises |
|---|---|---|
| `acp-provision-smoke.int.test.ts` | `RUN_ACP_INT=1` | **Every ACP agent** — provisions the credential, spawns `<agent> acp`, drives a real handshake, asserts it AUTHENTICATES + answers. |
| `kimi-acp-provision.int.test.ts` | `RUN_KIMI_INT=1` | Kimi-specific POSITIVE/NEGATIVE regression (credential slot). |
| `beads-configure.int.test.ts` | `RUN_BEADS_INT=1` | Real beads/Dolt config store. |
| `headroom-provision.int.test.ts` | `RUN_HEADROOM_INT=1` | Real Headroom enable/disable + `:8787/stats`. |
| `baton-loop.int.test.ts` | `RUN_BATON_INT=1` | Cross-mode resume: a natively-created claude session resumes through the baton's ACP path. |
| `baton-local.int.test.ts` | `RUN_BATON_INT=1` | **Whole local baton, real claude** — take-control BEFORE the first TUI turn → `MOBILE_DRIVE`, a real ACP turn, handback → `LOCAL_DRIVE`, zero TUI chrome in the chat pipe, and the `online:false` goodbye heartbeat on SIGINT. |

## `acp-provision-smoke.int.test.ts` — automated CLAUDE.md Step 8

This is the **automated form of CLAUDE.md "adding a new agent" Step 8**
("verify a live deploy launches the NEW agent AUTHENTICATED, not Claude"),
which is manual today. It catches the class of bug unit tests miss — an agent
provisioned but returning empty responses, `-32000 Authentication required`, or
the *wrong* agent — because unit tests assert file/config **content**, not ACP
**behaviour**.

For each supported ACP agent it:

1. Provisions the credential into an isolated `$HOME` using the **real** prod
   provisioner (`provisionAgentCredentials` from
   `src/commands/host/agent-provisioning.ts`) — never re-implemented, so the
   test tracks prod.
2. Spawns the agent's ACP server using the **real** spawn recipe from the
   adapter `REGISTRY` (`getAcpAdapter(agentId)`).
3. Drives `initialize → session/new → session/prompt` (shared driver
   `../fixtures/acp-smoke-driver.ts` `acpSmokeDrive`) and asserts:
   `session/new` returns no `-32000`, and `session/prompt` **streams real
   assistant text** — no auth error, no empty response, no silent wedge.

> Note: `initialize` `authMethods` is informational only. Some agents (kimi)
> advertise `login` STATICALLY even when authenticated, so the real auth signal
> is the `session/prompt` outcome, not the initialize handshake.

### Gate + credential env vars

The whole suite is `describe.skip` unless `RUN_ACP_INT=1`. Within it, each agent
row **skips cleanly** when its credential env var(s) are absent, or when its ACP
binary isn't installed — so a gated run exercises only whatever creds you supply.
**Never hardcode a token**; every credential is read from the environment.

| Agent | Credential env var(s) | Default `authKind` |
|---|---|---|
| claude | `CLAUDE_TEST_CREDENTIAL_JSON` | `oauth_token` |
| codex  | `CODEX_TEST_CREDENTIAL_JSON`  | `oauth_token` |
| gemini | `GEMINI_TEST_CREDENTIAL_JSON` | `oauth_token` |
| cursor | `CURSOR_TEST_CREDENTIAL_JSON` | `oauth_token` |
| kimi   | `KIMI_TEST_CREDENTIAL_JSON`   | `oauth_token` |
| house  | `HOUSE_TEST_BASE_URL` + `HOUSE_TEST_TOKEN` (+ optional `HOUSE_TEST_MODEL`) | n/a (MiniMax proxy) |

The credential must be a LIVE blob of the row's kind (an oauth login-state JSON,
or an API key). Override the provisioning kind with `<AGENT>_TEST_AUTH_KIND`
(`api_key` | `oauth_token`) when your credential isn't the default. The **house**
row runs the claude adapter pointed at the managed MiniMax proxy (no cred files).

### Run it

```bash
# One agent (kimi), locally:
RUN_ACP_INT=1 KIMI_TEST_CREDENTIAL_JSON="$(cat ~/.kimi-code/credentials/kimi-code.json)" \
  npx vitest run acp-provision-smoke

# Several agents at once (nightly): set whichever creds you have.
RUN_ACP_INT=1 \
  CLAUDE_TEST_CREDENTIAL_JSON="$(cat ~/.claude/.credentials.json)" \
  CODEX_TEST_CREDENTIAL_JSON="$(cat ~/.codex/auth.json)" \
  npx vitest run acp-provision-smoke
```

Add `--disableConsoleIntercept` to see the per-agent `outcome=… frames` line
(handshake trace) even on a passing run.

### Adding a FUTURE agent

**One row** in the `AGENTS` table (`{ key, publicAgentId, adapterId,
displayName, credEnvVars, authKind }`). The spawn recipe already lives in the
adapter `REGISTRY`; the driver is shared — no other changes.

### Nightly CI (not wired — how to add)

`.github/workflows/ci.yml` runs `npm test` **without** any `RUN_*_INT` gate, so
this suite is a no-op there. To run it nightly, add a separate gated job (a
`schedule:` cron) that sets `RUN_ACP_INT=1` plus whatever `*_TEST_CREDENTIAL_JSON`
secrets are configured, then runs
`(cd apps/cli && npx vitest run acp-provision-smoke)`. Rows with no secret skip
cleanly, so the job is green until you add the first credential secret.

## `baton-local.int.test.ts` — the local Session Baton, end to end

Runs the REAL composition root (`runBatonSession`) — real native `claude` TUI,
real ACP adapter, real `CommandRelayService`/controller/drivers/mirror —
against an in-process stub backend that serves `/api/commands/pending` and
captures `/api/baton/events`, `/api/commands/output`, `/api/commands/result`
and `/api/plugin/heartbeat`. Nothing under `src/` is mocked; only the backend
is faked (`CODEAM_API_URL` points at the stub).

It is the regression gate for the three 2026-08-18 owner-reported bugs:

1. **Take Control before the first TUI turn** — the scenario that hung: the
   pre-minted conversation id has no transcript on disk, so `session/load`
   never resolved and the baton wedged in `SWITCHING`. Verified red: reverting
   the `AcpDriver` zero-turn guard makes this time out waiting for
   `MOBILE_DRIVE`.
2. **No screen-scrape in LOCAL_DRIVE** — a prompt sent from mobile while the
   terminal holds the baton must not pump raw TUI frames into the chat.
   Verified red: un-suppressing `OutputService` publishes box-drawing chrome.
3. **Goodbye heartbeat** — SIGINT posts `online:false` BEFORE `process.exit`.

```bash
RUN_BATON_INT=1 npx vitest run integration/baton-local   # ~45 s, one real claude turn
```

Skips cleanly (with a printed reason) when `RUN_BATON_INT` is unset or
`claude --version` fails, so CI stays green until an authenticated claude is
provisioned on the runner.
