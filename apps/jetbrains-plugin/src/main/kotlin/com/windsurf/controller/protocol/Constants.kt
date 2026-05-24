package com.windsurf.controller.protocol

/**
 * Shared wire / lifecycle constants. Kotlin mirror of
 * `packages/shared/src/protocol/constants.ts` — Kotlin can't import
 * an npm package, so this file is the source of truth for the JB
 * plugin. When you change a value here, also update the TS
 * counterpart and the inverse (a TS bump that doesn't propagate
 * means a backend that 426s the JB client at the next protocol
 * sweep).
 */

/**
 * Discriminated chunk-protocol version sent as the
 * `X-Codeam-Protocol-Version` header on every authed request.
 */
const val PROTOCOL_VERSION = "2.0.0"

/**
 * The VS Code AgentOutputMonitor's loopback HTTP server default
 * port. JB doesn't run an observer bridge itself but the constant
 * is the documented starting port for tooling that probes whether
 * a CodeAgent Mobile session is active locally.
 */
const val OBSERVER_BRIDGE_PORT = 47832

/**
 * Default plugin → backend heartbeat interval. User-configurable
 * via `heartbeatIntervalMs` in SettingsService's @State.
 */
const val HEARTBEAT_INTERVAL_MS_DEFAULT = 30_000L

/** SSE + polling reconnect cap; matches the TS constant. */
const val SSE_SOCKET_TIMEOUT_MS = 35_000L
