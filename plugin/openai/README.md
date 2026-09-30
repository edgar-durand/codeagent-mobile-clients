# CodeAgent Mobile — OpenAI plugin package

The static plugin package that lists CodeAgent Mobile in the ChatGPT / Codex
plugin directory. It carries no code — it's a manifest, an MCP server pointer,
and a set of skills that teach the model how to use the already-live
`https://mcp.codeagent-mobile.com/mcp` gateway (13 tools: sessions, agents,
wallet, diff, PR, mobile hand-off).

## Layout

- `plugin.json` / `.codex-plugin/plugin.json` — the listing manifest (must stay
  byte-identical; Codex reads the `.codex-plugin/` copy, the portal reads the
  root one).
- `mcp.json` — points the connector at the production streamable-http MCP
  endpoint. Never a dev/staging URL.
- `.app.json` — empty `com.openai` apps declaration (no embedded UI app).
- `assets/` — logo, composer icon, screenshots (see Plan 04 Task 3).
- `skills/` — one `SKILL.md` per workflow (`start-coding-task`,
  `supervise-session`, `review-agent-work`,
  `continue-with-codeagent-credits`). These describe *when* to call each MCP
  tool and how to react to its result/error codes — they never tell the model
  to skip a confirmation (e.g. `switch_agent`'s `confirm_wallet_use`).

## Packing

```bash
npm run plugin:pack
```

Validates the manifest against the portal limits (`displayName` ≤ 30 chars,
`shortDescription` ≤ 30, `longDescription` ≤ 4000, required URLs present,
every asset path exists), validates every skill's frontmatter, then writes
`dist/codeagent-mobile-plugin-<version>.zip` with `plugin.json` at the archive
root.

## Testing locally

- **ChatGPT developer mode** — Settings → Connectors → Advanced → Developer
  mode → add the MCP server URL from `mcp.json` directly, or import the packed
  ZIP once developer-mode plugin import is available for your account.
- **Codex** — `codex plugin install ./plugin/openai` for a local install, or
  follow the marketplace submission path documented at
  developers.openai.com/plugins/build/plugins.

## Versioning rule

**Server changes ship on their own** — the gateway at
`mcp.codeagent-mobile.com` deploys independently and picking up a new tool or
bug fix needs no plugin republish. **Skill or metadata changes need a new
ZIP** — bump `version` in `plugin.json` (and its `.codex-plugin/` mirror),
re-run `npm run plugin:pack`, and resubmit.
