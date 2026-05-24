/**
 * Shared wire / lifecycle constants. The values here are bundled
 * into the CLI + VS Code extension at build time via tsup / esbuild
 * and mirrored in `apps/jetbrains-plugin/.../protocol/Constants.kt`
 * since Kotlin can't import an npm package.
 *
 * If you change one of these values, also update the Kotlin mirror.
 */

/**
 * Discriminated chunk-protocol version sent as the
 * `X-Codeam-Protocol-Version` header on every authed request. The
 * backend uses this to opt into legacy translations or to reject
 * with 426 when the client is too far behind. Bumped in lockstep
 * with chunk-shape changes (e.g. when the `chrome_steps` chunk
 * type is added).
 */
export const PROTOCOL_VERSION = '2.0.0' as const;

/**
 * The VS Code AgentOutputMonitor's loopback HTTP server bound to
 * 127.0.0.1 on this port — the observer JS in the IDE renderer
 * uses it to round-trip captured chat content back into the
 * extension host. The port is intentionally fixed (rather than
 * `listen(0)`) so the observer script can be a static constant
 * rather than dynamically rewriting itself per session.
 *
 * Multi-window collision is solved by listen(0) per-window in the
 * monitor (see #103); this default is still the documented
 * starting port for tooling that needs to probe whether a CodeAgent
 * Mobile session is active locally.
 */
export const OBSERVER_BRIDGE_PORT = 47832;

/**
 * Default plugin → backend heartbeat interval. User-configurable
 * via `codeagent-mobile.heartbeatIntervalMs` on VS Code and
 * `heartbeatIntervalMs` in SettingsService.kt's @State on JetBrains.
 * Mirrors the value the apps/api side uses to flip the paired
 * session to offline.
 */
export const HEARTBEAT_INTERVAL_MS_DEFAULT = 30_000;

/**
 * SSE + polling reconnect cap. Vercel's serverless functions close
 * SSE connections after ~25 s by default; the client uses 35 s as
 * its overall socket timeout to leave a beat for graceful close.
 */
export const SSE_SOCKET_TIMEOUT_MS = 35_000;
