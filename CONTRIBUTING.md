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

## Commit message convention

This repo uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit message must look like:

```
<type>(<scope>): <short summary>
```

**Allowed types:** `feat`, `fix`, `refactor`, `perf`, `docs`, `build`, `ci`, `test`, `chore`, `style`, `revert`.

**Allowed scopes:** `cli`, `vsc-plugin`, `jetbrains-plugin`, `shared`, `workflow`, `meta`, `deps`, `release`, `changelog`.

**Breaking changes:** add `!` after the type or scope (e.g., `feat(cli)!: drop Node 18 support`) **or** include a `BREAKING CHANGE:` footer.

The message type drives the [automated changelog](#releases) — `feat` → *Added*, `fix` → *Fixed*, `refactor` → *Changed*, `perf` → *Performance*, `docs` → *Documentation*, `build`/`ci` → *Build*/*CI*, `style` is skipped, and any commit marked breaking gets a `⚠️ BREAKING CHANGE` tag.

**Set up the commit template locally** so `git commit` shows the full reference:

```bash
npm run use-commit-template
```

This runs `git config commit.template .gitmessage` inside this repo only. Every PR is gated by `commitlint` in CI — non-conforming commit messages will fail the lint check.

## Pull request checklist

- [ ] Every commit follows the convention above (enforced by CI).
- [ ] `npm run test` (CLI) passes, and builds succeed for any touched app.
- [ ] No secrets or personal tokens committed. Never commit `.env`.
- [ ] If the PR changes wire-protocol shapes (chunks, commands), the other clients still work with the old shape or are updated in the same PR.

> You do **not** need to update `CHANGELOG.md` by hand — the release pipeline auto-generates entries from commit messages.

## Releases

Releases are tag-triggered. Pushing a tag `vX.Y.Z`:

1. Patches the version across every package manifest (CLI `package.json`, VS Code `package.json`, JetBrains `build.gradle.kts` + `plugin.xml`).
2. Runs the CLI test suite.
3. Builds and packages all three clients.
4. Publishes `codeam-cli@X.Y.Z` to npm, and `CodeAgentMobile.codeagent-mobile@X.Y.Z` to both the VS Code Marketplace and Open VSX.
5. Runs [git-cliff](https://git-cliff.org/) against the commits between the previous tag and this one to produce a Keep-a-Changelog section.
6. Prepends that section to each app's `CHANGELOG.md` and commits the update back to `main` with `[skip ci]`.
7. Creates a GitHub Release using the same generated notes, with the `.tgz`, `.vsix`, and JetBrains `.zip` attached.

The JetBrains plugin is built and attached to the GitHub Release, but the upload to the JetBrains Marketplace stays manual for now.

See [.github/workflows/release.yml](.github/workflows/release.yml) for the full pipeline. Only maintainers with access to the publishing secrets (`NPM_TOKEN`, `VSCE_PAT`, `OVSX_TOKEN`) can cut releases.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating, you agree to abide by it.

## License

By contributing you agree that your contributions will be licensed under the [MIT License](LICENSE).
