# @codeam/shared

The **wire-protocol contract** for [CodeAgent Mobile](https://codeagent-mobile.com) —
the shapes, constants, and pure renderers every surface that crosses a process
boundary (CLI ⇄ backend ⇄ mobile/web) must agree on byte-for-byte.

## What's inside

- `protocol/renderToLines` — virtual terminal that turns raw PTY bytes into clean screen lines (CSI cursor moves, erase, alternate-screen, CR/LF quirks).
- `protocol/remote-command` — the `RemoteCommand` envelope (zod schema + `toRemoteCommand()` validator) used by the SSE `commands` stream and the `/api/commands/pending` polling fallback.
- `protocol/constants` — wire constants (`PROTOCOL_VERSION`, SSE timeouts, ports, heartbeat intervals).
- `protocol/chrome-types` — protocol-level shapes for TUI chrome steps and interactive selectors.
- `models/pricing` — Anthropic model pricing and context-window tables with lookup helpers.
- `agents/` — agent id types and registry shared by the clients.
- `types/` — cross-repo wire types (`preview`, `beads`, `headroom`, `streaming`, `file-change`) and `types/events` (`USER_EVENTS`, the canonical map of per-user SSE event names).

## Consumers

- [`codeam-cli`](https://www.npmjs.com/package/codeam-cli) and the VS Code / Cursor / Windsurf extension bundle this package's **source** at build time (workspace dep).
- The CodeAgent Mobile backend and apps consume the **published** package from npm.

Dual CJS + ESM with bundled type declarations. `zod` is the only runtime dependency.

## Versioning

Versions in lockstep with the unified client release line: a `vX.Y.Z` tag in
[`codeagent-mobile-clients`](https://github.com/edgar-durand/codeagent-mobile-clients)
publishes `@codeam/shared@X.Y.Z` alongside the CLI and IDE plugins.

## License

MIT
