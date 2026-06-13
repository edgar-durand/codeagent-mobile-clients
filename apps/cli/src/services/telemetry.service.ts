/**
 * PostHog telemetry for the CLI.
 *
 * Shares the same PostHog project mobile + landing use (US-region
 * ingestion). Identified analytics — when a user is paired, we
 * identify by their backend userId + send name/email/plan as person
 * properties. Anonymous CLI invocations (pre-pair, `codeam pair`,
 * `codeam doctor`) capture under a stable per-install distinct id
 * cached in `~/.codeam/anon.json`, then alias to the real userId
 * once `identifyUser` fires.
 *
 * Captured context (the product owner explicitly asked for "toda
 * la info del contexto"):
 *   - super properties: cliVersion, node, platform, arch
 *   - person properties (on identify): userId, email, name, plan,
 *     pairedSessionCount, preferredAgent
 *   - per-event properties: sessionId, pluginId, agentId, ptyStrategy,
 *     plus event-specific fields.
 *
 * NEVER captured (privacy invariant):
 *   - pluginAuthToken (HMAC secret — would let anyone with PostHog
 *     access impersonate a user)
 *   - model-provider API keys (ANTHROPIC_API_KEY etc.)
 *   - prompt text, agent stdout, file contents, file paths inside
 *     the user's project
 *
 * Opt-out:
 *   - `CODEAM_TELEMETRY=0` env var disables capture + flushes
 *     nothing. The init still runs (cheap) so toggling the var
 *     mid-session takes effect on the next invocation.
 *   - `CI` env var (set by every CI runner) auto-disables.
 *   - `NODE_ENV=test` auto-disables — vitest runs shouldn't ship
 *     events.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { PostHog } from 'posthog-node';
import { log } from './logger';

// Injected by tsup's `define` at build time. Empty in dev / locally
// built tarballs unless the env var was set at build time.
declare const __POSTHOG_API_KEY__: string;
declare const __POSTHOG_HOST__: string;
declare const __CLI_VERSION__: string;

const ANON_FILE = path.join(os.homedir(), '.codeam', 'anon.json');

let client: PostHog | null = null;
let distinctId: string | null = null;
let identified = false;

function isOptedOut(): boolean {
  // Explicit opt-out > CI auto-skip > test auto-skip > NO_TELEMETRY
  // (de-facto industry standard env var, honoured for free).
  if (process.env.CODEAM_TELEMETRY === '0') return true;
  if (process.env.CI) return true;
  if (process.env.NODE_ENV === 'test') return true;
  if (process.env.NO_TELEMETRY) return true;
  return false;
}

function readAnonId(): string {
  // Stable per-install id. Mirrors PostHog's anonymous-distinct-id
  // pattern from the web SDK — the CLI doesn't have cookies so we
  // persist a tiny JSON blob in ~/.codeam/anon.json that survives
  // across CLI invocations + maps to the same user when they
  // eventually pair.
  try {
    if (fs.existsSync(ANON_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ANON_FILE, 'utf8')) as { id?: string };
      if (typeof raw.id === 'string' && raw.id.length > 0) return raw.id;
    }
  } catch {
    /* corrupt or unreadable — regenerate below */
  }
  const id = `anon-${randomUUID()}`;
  try {
    fs.mkdirSync(path.dirname(ANON_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(ANON_FILE, JSON.stringify({ id }), { mode: 0o600 });
  } catch {
    /* unwritable home — distinctId still works for THIS process */
  }
  return id;
}

/**
 * PostHog's Node SDK accepts a plain JSON-shaped properties bag.
 * Local alias avoids dragging an SDK type into every call site; the
 * SDK happily takes anything serialisable. We allow `undefined` at
 * the call-site level so optional fields (`runtime?: string`) can
 * be passed without ceremony; `capture()` strips undefined before
 * forwarding to the SDK.
 */
type TelemetryProperties = Record<string, string | number | boolean | null | undefined>;
type PostHogJsonProperties = Record<string, string | number | boolean | null>;

function superProperties(): PostHogJsonProperties {
  return {
    cliVersion: typeof __CLI_VERSION__ !== 'undefined' ? __CLI_VERSION__ : '0.0.0-dev',
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
  };
}

/**
 * Telemetry must NEVER take the CLI down with it. PostHog's flush throws a
 * `PostHogFetchNetworkError` on any transport failure (DNS / offline /
 * restricted network — `getaddrinfo ENOTFOUND us.i.posthog.com`). Left
 * unhandled, the SDK's background flush then:
 *   1. `console.error`s the whole stack — which in `codeam start` /
 *      `pair-auto` bleeds into the very terminal the agent PTY renders into
 *      and derails live sessions, and
 *   2. keeps the failed batch on the queue and retries it every
 *      `flushInterval`, so the queue (and memory) grow without bound while
 *      the network is down.
 *
 * Analytics is best-effort, so we wrap `fetch`: a transport failure resolves
 * to a synthetic `200` instead of throwing. The SDK treats the batch as
 * delivered, drains the queue (no retry storm, no growth), and stays silent
 * — events are simply dropped until connectivity returns. Real HTTP error
 * responses (4xx/5xx) come back resolved and flow through untouched.
 */
// Exact shape PostHog expects for its `fetch` option — derived from the
// constructor so we don't import (transitive) `@posthog/core` types.
type PostHogFetch = NonNullable<NonNullable<ConstructorParameters<typeof PostHog>[1]>['fetch']>;

const resilientFetch: PostHogFetch = async (url, options) => {
  try {
    return await fetch(url, options);
  } catch (err) {
    log.trace(
      'telemetry',
      `posthog transport failed — dropping batch (network unreachable): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {
      status: 200,
      text: async () => '',
      json: async () => ({}),
      body: null,
    };
  }
};

/**
 * Initialise the PostHog client. Safe to call more than once — the
 * second call is a no-op. Returns true when capture is active.
 */
export function initTelemetry(): boolean {
  if (client) return true;
  if (isOptedOut()) {
    log.trace('telemetry', 'opted out (CODEAM_TELEMETRY / CI / NODE_ENV=test)');
    return false;
  }
  const apiKey = typeof __POSTHOG_API_KEY__ !== 'undefined' ? __POSTHOG_API_KEY__ : '';
  if (!apiKey) {
    log.trace('telemetry', 'no PostHog API key baked into build — disabled');
    return false;
  }
  const host =
    typeof __POSTHOG_HOST__ !== 'undefined' ? __POSTHOG_HOST__ : 'https://us.i.posthog.com';
  distinctId = readAnonId();
  client = new PostHog(apiKey, {
    host,
    // 10s flush is generous for a CLI — most commands run < 30s
    // and we shutdown() before exit anyway. Per-batch size caps
    // memory growth on long-lived `codeam start` sessions.
    flushAt: 20,
    flushInterval: 10_000,
    // Network failures resolve to a synthetic 200 instead of throwing —
    // keeps a flaky/offline network from crashing the CLI or spamming the
    // session PTY. See resilientFetch above.
    fetch: resilientFetch,
  });
  // Any other SDK-emitted error (feature-flag load, etc.) goes to the file
  // logger, never to stdout/stderr — telemetry stays invisible to the user.
  client.on('error', (err) => {
    log.trace('telemetry', 'posthog error (ignored)', err);
  });
  // Register super props once — every capture inherits them.
  client.register(superProperties());
  log.trace('telemetry', `posthog client initialised host=${host} distinctId=${distinctId}`);
  return true;
}

/**
 * Promote the anonymous distinct id to the backend userId. Sends a
 * full person-properties payload (email / name / plan / paired-session
 * count / preferred agent) so the PostHog person view shows context
 * without us re-sending it on every event.
 *
 * `aliasFrom` argument: if the caller passes the prior anonymous id,
 * PostHog stitches the pre-pair events to the now-identified user.
 */
export interface IdentifyParams {
  userId: string;
  email?: string;
  name?: string;
  plan?: string;
  pairedSessionCount?: number;
  preferredAgent?: string;
}

export function identifyUser(params: IdentifyParams): void {
  if (!client || !distinctId) return;
  if (identified) return;
  identified = true;
  // PostHog Node SDK alias: stitch the anonymous distinct id under
  // the user's backend userId so pre-pair captures roll up to the
  // identified person.
  if (distinctId && distinctId !== params.userId) {
    client.alias({ distinctId, alias: params.userId });
  }
  distinctId = params.userId;
  // Drop undefined fields so the PostHog JsonType constraint holds
  // (the IdentifyParams shape uses optional properties for ergonomics).
  const personProps: PostHogJsonProperties = {};
  if (params.email !== undefined) personProps.email = params.email;
  if (params.name !== undefined) personProps.name = params.name;
  if (params.plan !== undefined) personProps.plan = params.plan;
  if (params.pairedSessionCount !== undefined) personProps.pairedSessionCount = params.pairedSessionCount;
  if (params.preferredAgent !== undefined) personProps.preferredAgent = params.preferredAgent;
  client.identify({
    distinctId: params.userId,
    properties: personProps,
  });
  log.trace('telemetry', `identified user=${params.userId} plan=${params.plan ?? 'unknown'}`);
}

/**
 * Fire-and-forget event capture. The PostHog Node SDK batches
 * internally + flushes via flushInterval — no need to await.
 */
export function capture(event: string, properties: TelemetryProperties = {}): void {
  if (!client || !distinctId) return;
  // Per-event safety filter — strip anything that looks like a
  // token / API key so a future caller can't accidentally leak a
  // secret by passing it as a property. Generic but cheap. We also
  // drop undefined entries so PostHog's JsonType invariant holds
  // (the call-site type allows undefined for ergonomics).
  const safe: PostHogJsonProperties = {};
  for (const [k, v] of Object.entries(properties)) {
    if (v === undefined) continue;
    if (/token|secret|api[-_]?key|password/i.test(k)) {
      log.trace('telemetry', `redacted property ${k} on event ${event}`);
      continue;
    }
    safe[k] = v;
  }
  client.capture({ distinctId, event, properties: safe });
}

/**
 * Flush any queued events. Called from the process exit path so
 * short-lived commands (`codeam status`, `codeam version`) don't
 * drop the cli_boot event on the floor.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown();
  } catch (err) {
    log.warn('telemetry', 'shutdown failed', err);
  } finally {
    client = null;
    identified = false;
  }
}

/**
 * One-shot first-install notice. Prints to stderr the first time
 * the CLI runs after install — sets a marker file so subsequent
 * invocations stay quiet. Mirrors the postinstall message and adds
 * the telemetry opt-out hint.
 */
export function maybePrintFirstRunBanner(): void {
  if (isOptedOut()) return;
  const marker = path.join(os.homedir(), '.codeam', '.telemetry-notice');
  try {
    if (fs.existsSync(marker)) return;
    fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, new Date().toISOString());
  } catch {
    /* unwritable home — fall through to print the notice anyway */
  }
  process.stderr.write(
    '\n  codeam-cli sends anonymous + identified usage events to PostHog\n' +
      '  (same project as the mobile + web apps). Opt out at any time:\n' +
      '    export CODEAM_TELEMETRY=0\n' +
      '  See https://github.com/edgar-durand/codeagent-mobile-clients#telemetry\n\n',
  );
}

/** Test-only escape hatches. */
export const _testHelpers = {
  reset(): void {
    client = null;
    distinctId = null;
    identified = false;
  },
  getClient(): PostHog | null {
    return client;
  },
  getDistinctId(): string | null {
    return distinctId;
  },
  isOptedOut,
  resilientFetch,
};
