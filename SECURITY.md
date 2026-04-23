# Security Policy

## Reporting a vulnerability

If you find a security issue in any of the client apps in this repo, please **do not open a public issue**. Instead, report it privately via one of:

- GitHub's private vulnerability reporting: https://github.com/edgar-durand/codeagent-mobile-clients/security/advisories/new
- Email: **security@codeagent-mobile.com**

Please include:

- Which client app is affected (`cli`, `vsc-plugin`, or `jetbrains-plugin`) and its version
- A description of the issue
- Steps to reproduce or a proof-of-concept
- Impact (what an attacker could do)

## What to expect

- **Acknowledgement** within 3 business days
- **Initial assessment** within 7 business days
- **Fix plan and timeline** shared with the reporter before disclosure
- **Credit** in the release notes of the patched version if you want it

## Scope

In scope:

- The CLI (`codeam-cli`)
- The VS Code / Cursor / Windsurf extension
- The JetBrains plugin
- The GitHub Actions workflows in this repo (if they could leak secrets)

Out of scope (reach out through the in-app **Help & FAQ** instead):

- The CodeAgent Mobile backend API
- The mobile app for iOS and Android
- The web dashboard at codeagent-mobile.com
- Third-party AI agents the clients wrap (Claude Code, Copilot, Cursor, etc.)

## Supported versions

Only the latest minor of each app receives security updates. Please upgrade before reporting.

| App | Supported |
|---|---|
| `codeam-cli` | latest |
| VS Code plugin | latest |
| JetBrains plugin | latest |
