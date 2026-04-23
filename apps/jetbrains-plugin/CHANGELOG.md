# Changelog

All notable changes to the CodeAgent-Mobile JetBrains plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.7] — 2026-04-13

### Added
- Terminal-based agent handling: the plugin now drives the built-in IntelliJ terminal to send prompts, monitor output, and relay interactive confirmations to the mobile app.
- Session management improvements: pluginId forwarded in terminal output, stricter session validation.

## [1.0.5] — 2026-03-20

### Added
- Multi-IDE support: compatibility extended across the IntelliJ family (IDEA, WebStorm, PyCharm, Rider, GoLand, etc.).
- Enhanced pairing and session management.

## [1.0.3] — 2026-03-16

### Fixed
- Cascade prompt dispatch now uses JCEF JavaScript injection instead of Robot paste — avoids focus-stealing and fixes intermittent "nothing happened" after sending a prompt.

## [1.0.1] — 2026-03-15

### Changed
- Extended IDE compatibility to build `261.*`, adding support for WebStorm 2025.3+.

## [1.0.0] — 2026-03-14

### Added
- Initial release. Secure device pairing via 6-digit code, real-time agent status, WebSocket-based live communication, MCP server configuration, and a dedicated tool window in the IDE.
- Claude Code terminal support — detect, send prompts, and monitor output.

---

Published releases live on the [JetBrains Marketplace](https://plugins.jetbrains.com/plugin/30697-codeagent-mobile).
