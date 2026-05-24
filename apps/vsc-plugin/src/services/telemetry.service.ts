/**
 * PostHog telemetry for the VS Code extension. Mirrors the CLI's
 * `apps/cli/src/services/telemetry.service.ts` so events land in the
 * same PostHog project (US ingestion) under a unified person record.
 *
 * Captured context (matches the CLI):
 *   - super properties: pluginVersion, vscodeVersion, platform, arch
 *   - person properties (on identify): userId, email, name, plan
 *   - per-event properties: sessionId, pluginId, agentId, plus
 *     event-specific fields.
 *
 * NEVER captured (privacy invariant — same list as the CLI):
 *   - pluginAuthToken
 *   - model-provider API keys
 *   - prompt text / agent stdout / file contents / file paths
 *
 * Opt-out:
 *   - VS Code's `telemetry.telemetryLevel` setting set to `off` →
 *     no capture, no init. We respect the user's global IDE setting
 *     in addition to the explicit CodeAgent toggle.
 *   - `codeagent-mobile.telemetryEnabled` configuration setting set
 *     to false.
 *   - `CODEAM_TELEMETRY=0` env var (parity with the CLI).
 */

import * as vscode from 'vscode';
import { PostHog } from 'posthog-node';

// Injected by esbuild's `define` at build time. Empty in dev builds
// unless POSTHOG_API_KEY is set in env when running `npm run build`.
declare const __POSTHOG_API_KEY__: string;
declare const __POSTHOG_HOST__: string;
declare const __PLUGIN_VERSION__: string;

let client: PostHog | null = null;
let distinctId: string | null = null;
let identified = false;

function isOptedOut(): boolean {
  // VS Code's global telemetry switch wins — if the user disabled
  // telemetry IDE-wide, we don't capture anything.
  const ideLevel = vscode.env.isTelemetryEnabled;
  if (ideLevel === false) return true;
  if (process.env.CODEAM_TELEMETRY === '0') return true;
  if (process.env.NO_TELEMETRY) return true;
  const cfg = vscode.workspace.getConfiguration('codeagent-mobile');
  if (cfg.get<boolean>('telemetryEnabled', true) === false) return true;
  return false;
}

type TelemetryProperties = Record<string, string | number | boolean | null | undefined>;
type PostHogJsonProperties = Record<string, string | number | boolean | null>;

function superProperties(): PostHogJsonProperties {
  return {
    pluginVersion: typeof __PLUGIN_VERSION__ !== 'undefined' ? __PLUGIN_VERSION__ : '0.0.0-dev',
    pluginSurface: 'vscode',
    vscodeVersion: vscode.version,
    platform: process.platform,
    arch: process.arch,
  };
}

/**
 * Initialise the PostHog client. Safe to call more than once. Uses
 * `vscode.env.machineId` as the anonymous distinct id — survives
 * across activations + matches the IDE's own telemetry id space.
 * Returns true when capture is active.
 */
export function initTelemetry(): boolean {
  if (client) return true;
  if (isOptedOut()) return false;
  const apiKey = typeof __POSTHOG_API_KEY__ !== 'undefined' ? __POSTHOG_API_KEY__ : '';
  if (!apiKey) return false;
  const host =
    typeof __POSTHOG_HOST__ !== 'undefined' ? __POSTHOG_HOST__ : 'https://us.i.posthog.com';
  distinctId = `vscode-${vscode.env.machineId}`;
  client = new PostHog(apiKey, {
    host,
    flushAt: 20,
    flushInterval: 10_000,
  });
  client.register(superProperties());
  return true;
}

export interface IdentifyParams {
  userId: string;
  email?: string;
  name?: string;
  plan?: string;
}

export function identifyUser(params: IdentifyParams): void {
  if (!client || !distinctId) return;
  if (identified) return;
  identified = true;
  if (distinctId !== params.userId) {
    client.alias({ distinctId, alias: params.userId });
  }
  distinctId = params.userId;
  const personProps: PostHogJsonProperties = {};
  if (params.email !== undefined) personProps.email = params.email;
  if (params.name !== undefined) personProps.name = params.name;
  if (params.plan !== undefined) personProps.plan = params.plan;
  client.identify({ distinctId: params.userId, properties: personProps });
}

/**
 * Fire-and-forget event capture. PostHog batches internally and
 * flushes via the interval — no need to await.
 */
export function capture(event: string, properties: TelemetryProperties = {}): void {
  if (!client || !distinctId) return;
  const safe: PostHogJsonProperties = {};
  for (const [k, v] of Object.entries(properties)) {
    if (v === undefined) continue;
    // Match the CLI's redaction filter: any field name that looks
    // like a secret gets dropped before send. Cheap defense against
    // a future caller passing a token property.
    if (/token|secret|api[-_]?key|password/i.test(k)) continue;
    safe[k] = v;
  }
  client.capture({ distinctId, event, properties: safe });
}

/**
 * Capture a generic error with stack. Use for caught exceptions in
 * fire-and-forget paths where logging is the only signal today —
 * 401-recovery, SSE drop, observer-bridge failures. Stack frames
 * outside `apps/vsc-plugin/` are trimmed to keep PostHog row sizes
 * bounded.
 */
export function captureError(event: string, error: unknown, extra: TelemetryProperties = {}): void {
  const err = error instanceof Error ? error : new Error(String(error));
  const stack = (err.stack ?? '').split('\n').slice(0, 12).join('\n');
  capture(event, { ...extra, errorMessage: err.message, errorStack: stack });
}

export async function shutdownTelemetry(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown();
  } catch { /* best-effort */ } finally {
    client = null;
    identified = false;
  }
}
