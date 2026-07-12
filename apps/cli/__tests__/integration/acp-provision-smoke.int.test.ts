/**
 * ACP-provision smoke harness — the AUTOMATED form of CLAUDE.md Step 8
 * ("verify a live deploy launches the NEW agent AUTHENTICATED, not Claude").
 *
 * For EVERY supported ACP agent, this:
 *   1. Provisions the agent's credential into an isolated `$HOME` using the
 *      SAME code prod ships — `provisionAgentCredentials(...)` from
 *      `commands/host/agent-provisioning.ts` (env var vs login-state file vs
 *      config.toml, keyed by `auth.kind`). We call the real provisioner — the
 *      harness never re-implements the write logic, so it tracks prod.
 *   2. Spawns the agent's ACP server the SAME way the CLI does — the spawn
 *      recipe comes from `getAcpAdapter(agentId)` (the adapter `REGISTRY`,
 *      source of truth for HOW each agent's ACP server launches).
 *   3. Drives `initialize → session/new → session/prompt` (shared
 *      `acpSmokeDrive` helper) and asserts the auth BEHAVIOUR unit tests
 *      cannot: `session/new` does NOT return `-32000`, and `session/prompt`
 *      STREAMS real assistant text — no "Authentication required", no empty
 *      response, no wrong-agent hang.
 *
 * This catches the class of bug that keeps slipping through (agent provisioned
 * but empty responses / `-32000 Authentication required` / wrong agent)
 * because unit tests assert file/config CONTENT, not ACP BEHAVIOUR.
 *
 * ── Gating (no-op in normal CI) ───────────────────────────────────────────
 * The WHOLE suite is `describe.skip` unless `RUN_ACP_INT=1`. Within it, each
 * agent row is SKIPPED cleanly when its credential env var is absent (so a
 * gated CI run with no creds is green; a nightly/manual run with whatever
 * creds are present exercises those agents). A row is also skipped when the
 * agent's ACP binary isn't resolvable. NEVER hardcode a token — every
 * credential is read from the environment.
 *
 * Per-agent credential env vars (hold a LIVE credential of the row's authKind):
 *   claude  → CLAUDE_TEST_CREDENTIAL_JSON   (oauth_token JSON blob, or an api_key)
 *   codex   → CODEX_TEST_CREDENTIAL_JSON    (~/.codex/auth.json oauth blob, or api_key)
 *   gemini  → GEMINI_TEST_CREDENTIAL_JSON   (oauth_creds.json blob, or api_key)
 *   cursor  → CURSOR_TEST_CREDENTIAL_JSON   (oauth login blob {accessToken,...})
 *   kimi    → KIMI_TEST_CREDENTIAL_JSON     (device-flow oauth blob, or api_key)
 *   house   → HOUSE_TEST_BASE_URL + HOUSE_TEST_TOKEN  (MiniMax proxy; runs the
 *             claude adapter pointed at the managed base-url — no cred files)
 *
 * Optionally override a row's provisioning kind with
 * `<AGENT>_TEST_AUTH_KIND` (`api_key` | `oauth_token`) when the credential
 * you supply isn't the row's default.
 *
 *   RUN_ACP_INT=1 KIMI_TEST_CREDENTIAL_JSON="$(cat ~/.kimi-code/credentials/kimi-code.json)" \
 *     npx vitest run acp-provision-smoke
 *
 * Adding a FUTURE agent = ONE row in the AGENTS table below (id, displayName,
 * credEnvVar, authKind) + its spawn recipe already lives in the adapter
 * REGISTRY. No driver changes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentAuthKind, AgentId } from '@codeam/shared';

import { provisionAgentCredentials } from '../../src/commands/host/agent-provisioning';
import { getAcpAdapter } from '../../src/agents/acp/adapters';
import {
  isCommandOnPath,
  resolveClaudeNativeBinary,
} from '../../src/agents/acp/agent-binary';
import { expandPathForAgentBinaries } from '../../src/agents/acp/client';
import { acpSmokeDrive, type AcpSpawnSpec } from '../fixtures/acp-smoke-driver';

const RUN_ACP_INT = process.env.RUN_ACP_INT === '1';

/** Agent-auth env vars we STRIP from the base child env so ONLY the
 *  provisioned artifact can authenticate (a stray key in the dev's shell
 *  must not silently pass the test). Provisioning layers its own back on. */
const STRIP_AGENT_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'CURSOR_API_KEY',
  'KIMI_API_KEY',
];

interface AcpAgentRow {
  /** Human label for the test name. */
  key: string;
  /** Public agent id passed to `provisionAgentCredentials` (`''` for house —
   *  house has no cred files). */
  publicAgentId: string;
  /** Adapter-registry key used to resolve the spawn recipe (house → claude). */
  adapterId: AgentId;
  displayName: string;
  /** All env vars that must be present & non-empty for the row to RUN. */
  credEnvVars: string[];
  /** Default provisioning kind (override via `<AGENT>_TEST_AUTH_KIND`). */
  authKind: AgentAuthKind;
  /** Optional agent-specific child env (e.g. kimi's KIMI_CODE_HOME). */
  extraChildEnv?: (homeDir: string) => Record<string, string>;
  /** House proxy: skip provisioning, inject the MiniMax proxy env instead. */
  house?: boolean;
}

const AGENTS: AcpAgentRow[] = [
  {
    key: 'claude',
    publicAgentId: 'claude',
    adapterId: 'claude',
    displayName: 'Claude Code',
    credEnvVars: ['CLAUDE_TEST_CREDENTIAL_JSON'],
    authKind: 'oauth_token',
  },
  {
    key: 'codex',
    publicAgentId: 'codex',
    adapterId: 'codex',
    displayName: 'Codex CLI',
    credEnvVars: ['CODEX_TEST_CREDENTIAL_JSON'],
    authKind: 'oauth_token',
  },
  {
    key: 'gemini',
    publicAgentId: 'gemini',
    adapterId: 'gemini',
    displayName: 'Gemini CLI',
    credEnvVars: ['GEMINI_TEST_CREDENTIAL_JSON'],
    authKind: 'oauth_token',
  },
  {
    key: 'cursor',
    publicAgentId: 'cursor',
    adapterId: 'cursor',
    displayName: 'Cursor Agent',
    credEnvVars: ['CURSOR_TEST_CREDENTIAL_JSON'],
    authKind: 'oauth_token',
  },
  {
    key: 'kimi',
    publicAgentId: 'kimi',
    adapterId: 'kimi',
    displayName: 'Kimi Code',
    credEnvVars: ['KIMI_TEST_CREDENTIAL_JSON'],
    authKind: 'oauth_token',
    extraChildEnv: (home) => ({ KIMI_CODE_HOME: path.join(home, '.kimi-code') }),
  },
  {
    // The house agent ("CodeAgent Cloud") runs the CLAUDE adapter pointed at a
    // managed MiniMax proxy — no cred files, just the proxy base-url + token
    // (mirrors host-agent.ts's houseProxy env block). Gated on a live proxy.
    key: 'house',
    publicAgentId: '',
    adapterId: 'claude',
    displayName: 'CodeAgent Cloud (MiniMax)',
    credEnvVars: ['HOUSE_TEST_BASE_URL', 'HOUSE_TEST_TOKEN'],
    authKind: 'api_key',
    house: true,
  },
];

/** True if every gate env var for the row is present & non-empty. */
function credsPresent(row: AcpAgentRow): boolean {
  return row.credEnvVars.every((v) => (process.env[v] ?? '').trim().length > 0);
}

/**
 * If the row's ACP binary lives OFF the current PATH (SDK-bundled claude, a
 * locally-installed kimi under ~/.kimi-code/bin), return its directory so we
 * can prepend it to the child PATH — mirroring how prod's `AcpClient` augments
 * PATH at spawn (`expandPathForAgentBinaries`). Returns `null` when the binary
 * is already on PATH (no augmentation needed). Uses the REAL home — the binary
 * install lives there, not in the isolated per-test $HOME. */
function offPathBinaryDir(row: AcpAgentRow): string | null {
  const spec = getAcpAdapter(row.adapterId);
  const bin = spec?.requiresAgentBinary;
  if (!bin || isCommandOnPath(bin)) return null;
  if (bin === 'claude') {
    const p = resolveClaudeNativeBinary();
    return p ? path.dirname(p) : null;
  }
  if (bin === 'kimi') {
    const p = path.join(os.homedir(), '.kimi-code', 'bin', 'kimi');
    return fs.existsSync(p) ? path.dirname(p) : null;
  }
  return null;
}

/** Whether the row's ACP binary is resolvable right now (else skip). */
function binaryResolvable(row: AcpAgentRow): boolean {
  const spec = getAcpAdapter(row.adapterId);
  if (!spec) return false;
  return isCommandOnPath(spec.requiresAgentBinary) || offPathBinaryDir(row) !== null;
}

/** Resolve the effective provisioning kind for a row (env override wins). */
function authKindFor(row: AcpAgentRow): AgentAuthKind {
  const override = (process.env[`${row.key.toUpperCase()}_TEST_AUTH_KIND`] ?? '').trim();
  if (override === 'api_key' || override === 'oauth_token' || override === 'setup_token') {
    return override;
  }
  return row.authKind;
}

/**
 * Build the FULL child env for the ACP server: process.env minus stray agent
 * creds, pinned to the isolated `$HOME`, plus provisioning's returned env
 * (api_key path) and any agent-specific vars. For the house agent, inject the
 * MiniMax proxy env instead of provisioning.
 */
function buildChildEnv(row: AcpAgentRow, home: string): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of STRIP_AGENT_ENV) delete base[k];
  base.HOME = home;
  base.XDG_CONFIG_HOME = path.join(home, '.config');
  // Mirror prod: AcpClient spawns the adapter with an augmented PATH so a
  // globally-installed agent binary in any node tree is findable. Prepend the
  // off-PATH binary dir (SDK-bundled claude / local ~/.kimi-code/bin) too.
  const augmentedPath = expandPathForAgentBinaries(process.env.PATH ?? '');
  const offDir = offPathBinaryDir(row);
  base.PATH = offDir ? `${offDir}${path.delimiter}${augmentedPath}` : augmentedPath;

  if (row.house) {
    const houseConfigDir = path.join(home, '.codeam', 'house-claude');
    fs.mkdirSync(houseConfigDir, { recursive: true, mode: 0o700 });
    return {
      ...base,
      ANTHROPIC_BASE_URL: process.env.HOUSE_TEST_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: process.env.HOUSE_TEST_TOKEN,
      ANTHROPIC_MODEL: process.env.HOUSE_TEST_MODEL ?? 'MiniMax-M3',
      ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.HOUSE_TEST_MODEL ?? 'MiniMax-M3',
      ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.HOUSE_TEST_MODEL ?? 'MiniMax-M3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.HOUSE_TEST_MODEL ?? 'MiniMax-M3',
      CLAUDE_CONFIG_DIR: houseConfigDir,
    };
  }

  // Provision the real credential artifacts into the isolated home and merge
  // the env the provisioner returns (non-empty only for the api_key path).
  const credEnv = provisionAgentCredentials(
    row.publicAgentId,
    { kind: authKindFor(row), value: process.env[row.credEnvVars[0]]!.trim() },
    home,
  );
  return { ...base, ...(row.extraChildEnv?.(home) ?? {}), ...credEnv };
}

if (!RUN_ACP_INT) {
  // eslint-disable-next-line no-console
  console.log(
    '[acp-provision-smoke] SKIPPED — set RUN_ACP_INT=1 (+ per-agent *_TEST_CREDENTIAL_JSON creds) ' +
      'to run the real per-agent ACP auth handshake. This is the automated form of CLAUDE.md Step 8.',
  );
}

// eslint-disable-next-line vitest/valid-describe-callback
(RUN_ACP_INT ? describe : describe.skip)('ACP-provision smoke — real per-agent handshake auth check', () => {
  let home: string;
  let cwd: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-smoke-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-smoke-cwd-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  for (const row of AGENTS) {
    it(
      `${row.key} (${row.displayName}) — provisioned credential → session/prompt STREAMS, no -32000`,
      async (ctx) => {
        if (!credsPresent(row)) {
          // eslint-disable-next-line no-console
          console.log(
            `[acp-provision-smoke] ${row.key} SKIPPED — set ${row.credEnvVars.join(' + ')} to run it.`,
          );
          return ctx.skip();
        }
        if (!binaryResolvable(row)) {
          // eslint-disable-next-line no-console
          console.log(
            `[acp-provision-smoke] ${row.key} SKIPPED — its ACP binary isn't resolvable on this box.`,
          );
          return ctx.skip();
        }

        const spec = getAcpAdapter(row.adapterId);
        expect(spec, `no ACP adapter registered for ${row.adapterId}`).not.toBeNull();

        const env = buildChildEnv(row, home);
        const spawnSpec: AcpSpawnSpec = {
          command: spec!.command,
          args: spec!.args,
          env,
          cwd,
        };

        const result = await acpSmokeDrive(spawnSpec, { timeoutMs: 60_000 });
        // Surface the observed frames so a failure is diagnosable in CI logs.
        // eslint-disable-next-line no-console
        console.log(
          `[acp-provision-smoke] ${row.key} outcome=${result.outcome.kind} ` +
            `authMethods=[${result.initializeAuthMethods.join(',')}] ` +
            `sessionCreated=${result.sessionCreated} textLen=${result.streamedText.length}\n  ` +
            result.frames.join('\n  '),
        );

        // The load-bearing assertions (what Step 8 verifies manually):
        //  1. the handshake NEVER reports "Authentication required" (-32000),
        expect(result.outcome.kind, `auth failed: ${JSON.stringify(result.outcome)}`).not.toBe(
          'auth_error',
        );
        //  2. session/new succeeded (a real session, not a wrong-agent hang),
        expect(result.sessionCreated).toBe(true);
        //  3. session/prompt STREAMED real assistant text — not empty, not a
        //     silent wedge. `empty`/`timeout`/`rpc_error` all fail here.
        expect(result.outcome.kind).toBe('streamed');
      },
      120_000,
    );
  }
});
