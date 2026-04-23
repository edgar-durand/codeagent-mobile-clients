# Contributing to CodeAgent Mobile — Clients

Thanks for taking the time to contribute. This repo holds three public client apps:

- `apps/cli` — `codeam-cli` (npm)
- `apps/vsc-plugin` — VS Code / Cursor / Windsurf extension
- `apps/jetbrains-plugin` — IntelliJ-family plugin

The backend, mobile app, and web dashboard are not in this repo.

## Reporting bugs

Use the [issue tracker](https://github.com/edgar-durand/codeagent-mobile-clients/issues/new/choose). The "Bug report" template asks for:

- Which client app (cli / vsc-plugin / jetbrains-plugin)
- Version
- OS + IDE version (for plugin issues)
- Steps to reproduce
- Expected vs. actual behavior
- Logs if available

For a suspected security issue, see [SECURITY.md](SECURITY.md) first — **do not** open a public issue.

## Proposing changes

1. Open an issue first for non-trivial changes so we can align on scope before you invest time.
2. Fork the repo and create a branch off `main`.
3. Keep changes scoped to one app where possible. Cross-app changes (e.g., protocol tweaks) should come with updates to every affected app in the same PR.
4. Follow the code style enforced by `.prettierrc` and `.eslintrc.json`.
5. Add or update tests (CLI: Vitest in `apps/cli/__tests__/`). The VS Code and JetBrains plugins do not yet have automated test suites — PRs that introduce them are very welcome.
6. Update the relevant `CHANGELOG.md` under `## [Unreleased]`.

## Local dev loop

```bash
git clone https://github.com/edgar-durand/codeagent-mobile-clients.git
cd codeagent-mobile-clients

# CLI
(cd apps/cli && npm install && npm run dev)

# VS Code extension (watch mode + F5 in VS Code to launch Extension Host)
(cd apps/vsc-plugin && npm install && npm run watch)

# JetBrains plugin (launches a sandboxed IDE)
(cd apps/jetbrains-plugin && ./gradlew runIde)
```

Prereqs: Node ≥ 18, JDK 17 for the JetBrains plugin, and Python 3 on macOS / Linux for the CLI's PTY helper.

## Pull request checklist

- [ ] PR title follows the convention: `<type>(<scope>): <short description>` — types: `feat`, `fix`, `chore`, `docs`, `refactor`, `build`, `test`; scopes: `cli`, `vsc-plugin`, `jetbrains-plugin`, `workflow`, `meta`.
- [ ] CHANGELOG updated for the affected app(s).
- [ ] `npm run test` (CLI) passes, and builds succeed for any touched app.
- [ ] No secrets or personal tokens committed. Never commit `.env`.
- [ ] If the PR changes wire-protocol shapes (chunks, commands), the other clients still work with the old shape or are updated in the same PR.

## Releases

Releases are tag-triggered. Pushing a tag `vX.Y.Z` publishes `codeam-cli@X.Y.Z` to npm and `CodeAgentMobile.codeagent-mobile@X.Y.Z` to the VS Code Marketplace + Open VSX. The JetBrains plugin is currently released manually from the built `.zip` artifact.

See [.github/workflows/release.yml](.github/workflows/release.yml) for the full pipeline. Only maintainers with access to the publishing secrets can cut releases.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating, you agree to abide by it.

## License

By contributing you agree that your contributions will be licensed under the [MIT License](LICENSE).
