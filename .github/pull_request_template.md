<!--
PR title convention: <type>(<scope>): <short description>
  types : feat · fix · chore · docs · refactor · build · test · perf
  scopes: cli · vsc-plugin · jetbrains-plugin · workflow · meta · shared
-->

## Summary

<!-- One to three lines describing what changes and why. -->

## Affected app(s)

- [ ] `apps/cli`
- [ ] `apps/vsc-plugin`
- [ ] `apps/jetbrains-plugin`
- [ ] `packages/shared`
- [ ] CI / workflows
- [ ] Docs / repo meta only

## How was this tested

<!-- Describe the manual or automated checks you ran. -->

- [ ] CLI: `npm run test` passes
- [ ] CLI: `npm run build` succeeds
- [ ] VS Code: `npm run build && npx @vscode/vsce package` succeeds; tested via `F5` in the Extension Host
- [ ] JetBrains: `./gradlew buildPlugin` succeeds; tested via `./gradlew runIde`
- [ ] N/A — docs / meta only

## Checklist

- [ ] Updated the relevant `CHANGELOG.md` under `## [Unreleased]`
- [ ] No secrets, tokens, or `.env` files committed
- [ ] Wire-protocol changes (if any) stay backward compatible OR all affected clients are updated in this PR
