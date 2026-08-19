import pc from 'picocolors';
import { AGENT_REGISTRY, type AgentId } from '@codeam/shared';
import { addSession, getActiveSession, getActiveSessionForAgent, ensurePluginId, loadCliConfig, type SavedSession } from '../config';
import { acquireDaemonLock } from './pair-auto';
import { maybeStartHeadroomReporter, maybeResumeLocalHeadroomReporter } from './host-agent';
import { showIntro, showInfo, showError } from '../ui/banner';
import { CommandRelayService } from '../services/command-relay.service';
import { AgentService } from '../services/agent.service';
import { createRuntimeStrategy } from '../agents/registry';
import { getAcpAdapter, requiresAcp, resolveAcpAdapterWithRetry } from '../agents/acp/adapters';
import { waitForAdapterModuleGraph } from '../agents/acp/agent-binary';
import { runAcpSession, surfaceStartupFailure } from '../agents/acp/runner';
import { AcpPublisher } from '../agents/acp/publisher';
import { installRelayCrashGuards } from '../lib/process-guards';
import { OutputService } from '../services/output.service';
import { HistoryService } from '../services/history.service';
import { FileWatcherService } from '../services/file-watcher.service';
import { TurnFileAggregator } from '../services/turn-files/turn-file-aggregator';
import { RepoDirtyTracker } from '../services/turn-files/repo-dirty-tracker';
import { StreamingEmitterService } from '../services/streaming-emitter.service';
import { fetchQuotaUsage } from './start/quota-fetcher';
import { buildKeepAlive } from './start/keep-alive';
import {
  dispatchCommand,
  cleanupAttachmentTempFiles,
  type HandlerContext,
} from './start/handlers';
import { registerTerminalHandlers, closeAllTerminals } from '../services/terminal-ops.service';
import { killActiveSpawnAndCaptureChildren } from '../services/spawn-and-capture';
import {
  activePreviewSessionIds,
  killAllPreviews,
  provisionProjectDependencies,
} from '../services/preview';
import {
  fetchCurrentPluginAuthToken,
  postPreviewEvent,
} from '../services/pairing.service';
import { capture, identifyUser, shutdownTelemetry } from '../services/telemetry.service';
import { provisionBeadsForStart } from '../beads/wiring';
import { startClaudeCredentialSync } from '../agents/claude/credential-sync';
import { ensureBeadsWorkflowHint } from '../beads/workflow-hint';
import { ensureAgentStandard } from '../agents/agent-standard';
import { buildMcpServersForStart } from '../integrations/provision';
import { mergeWithLocalMcpServers } from '../services/local-mcp-servers';
import { provisionSkillsForStart } from '../skills/provision';
import type { StartedBeads } from '../beads';
import { isLocalSession, runtimeSupportsBaton } from '../baton/gate';
import { runBatonSession } from '../baton/wire-baton';
import { keepDeviceAwake } from '../services/keep-awake';
import { ensureClaudeOnboarded } from '../agents/claude/onboarding';
import { log } from '../services/logger';

/**
 * Wires the long-running services (PTY ↔ output relay ↔ command
 * dispatch ↔ history) into a paired-session run-loop. Every piece
 * of behaviour beyond wiring lives in a sibling module under
 * `start/` so this file stays a readable orchestrator.
 */
export async function start(
  requestedAgent?: AgentId,
  presetSession?: SavedSession,
): Promise<void> {
  // A stray unhandled rejection (a failed backend POST after `socket hang up`
  // / HTTP 404, a fire-and-forget flush) must NOT kill the relay daemon — it
  // leaves a codespace session hung forever with no supervisor to restart it.
  installRelayCrashGuards();
  showIntro();

  // When the user runs `codeam <agent>`, restore the most-recently-paired
  // session for THAT agent — not whatever session was last promoted to the
  // global activeSessionId pointer (which is shared across terminals and
  // gets clobbered every time any terminal pairs a new session).
  //
  // ⚠️ Warm-codespace multi-session (2026-07-25): a `presetSession` pins THIS
  // run to a SPECIFIC session, bypassing the shared `getActiveSession()` read.
  // The host-agent supervisor spawns one `pair-auto` child per deploy; each
  // `addSession()` clobbers the single "active" pointer, so without a preset all
  // concurrent children resolve the SAME (newest) session, collide on the
  // per-session daemon lock (`acquireDaemonLock`), and all but one `exit(0)` —
  // only ONE session ever survives on the box. Passing the child's own claimed
  // session makes the lock + the whole run per-deploy → N concurrent sessions.
  const session = presetSession
    ? presetSession
    : requestedAgent
      ? getActiveSessionForAgent(requestedAgent)
      : getActiveSession();
  if (!session) {
    if (requestedAgent) {
      const displayName = AGENT_REGISTRY[requestedAgent]?.displayName ?? requestedAgent;
      console.log(`  ${pc.dim(`No paired ${displayName} session found.`)}`);
      console.log(
        `  ${pc.dim(`Run ${pc.white('codeam pair')} from a ${displayName} setup to connect your mobile app.`)}\n`,
      );
    } else {
      console.log(`  ${pc.dim('No paired session found.')}`);
      console.log(`  ${pc.dim(`Run ${pc.white('codeam pair')} to connect your mobile app.`)}\n`);
    }
    process.exit(0);
  }

  // Per-session daemon singleton lock. At most ONE long-lived `codeam` daemon
  // runs per sessionId. Multiple code paths converge on start() for the same
  // session (pair-auto→start, bare `codeam`→start, install-relaunch→start,
  // wake-kick→start); without this guard they coexist and fight over the relay
  // SSE (split-brain). Fail-open: any lock-infra error lets the daemon proceed.
  // Exit code 0 so the bootstrap's `setsid nohup` launch sees success.
  if (!acquireDaemonLock(session.id)) {
    console.log(`  ${pc.dim('A codeam daemon for this session is already running — deferring to it.')}`);
    process.exit(0);
  }

  if (!session.agent) {
    throw new Error('Active session has no agent — re-pair with `codeam pair`.');
  }

  // Use the per-session pluginId (set since v1.4.6); fall back to the
  // installation-level pluginId for sessions paired with older CLIs.
  const pluginId = session.pluginId ?? ensurePluginId();

  showInfo(`${session.userName}  ·  ${pc.cyan(session.plan)}`);
  showInfo(`Launching ${AGENT_REGISTRY[session.agent].displayName}...\n`);

  // Telemetry: identify from the persisted session + capture the
  // agent-spawn event. Returning users (already paired) hit this
  // path on every `codeam` invocation; the identify is idempotent.
  identifyUser({
    userId: session.userEmail,
    email: session.userEmail,
    name: session.userName,
    plan: session.plan,
    preferredAgent: session.agent,
    pairedSessionCount: loadCliConfig().sessions.length,
  });
  capture('agent_used', {
    sessionId: session.id,
    pluginId,
    agentId: session.agent,
    requestedAgent: requestedAgent ?? null,
  });

  const cwd = process.cwd();

  // Refresh pluginAuthToken on every boot. The token is HMAC-derived
  // from JWT_SECRET on the backend; a secret rotation (or the
  // historical api-v1 → api-v2 cutover) leaves the cached token
  // mismatched and every /api/commands/output POST 401s with
  // INVALID_PLUGIN_TOKEN — mobile then sits on "Thinking…" forever
  // even though the agent answered correctly. Falling back to the
  // persisted token on lookup failure keeps offline / flaky-net
  // sessions working unchanged.
  const refreshed = await fetchCurrentPluginAuthToken(
    session.id,
    pluginId,
    session.pollSecret,
  );
  if (refreshed && refreshed !== session.pluginAuthToken) {
    addSession({ ...session, pluginAuthToken: refreshed });
    session.pluginAuthToken = refreshed;
    showInfo('Reconnected — refreshed plugin auth token.');
  } else if (refreshed) {
    // Token unchanged but reconnect succeeded — backend has flipped
    // session.status to ACTIVE + set the Redis online flag, so the
    // mobile dashboard un-greys without waiting for the next heartbeat.
    showInfo('Reconnected previous session.');
  }
  // Diagnostic for token-mismatch reports: prints the exact triple
  // the publisher will send so we can compare against the server-side
  // mint. Trace-only (CODEAM_DEBUG=1).
  const tokenForLog = session.pluginAuthToken ?? '(unset)';
  log.trace(
    'pluginAuth',
    `boot triple sessionId=${session.id} pluginId=${pluginId} tokenLen=${tokenForLog.length} tokenHead=${tokenForLog.slice(0, 12)} tokenTail=${tokenForLog.slice(-8)} mintedEqualsCached=${refreshed === session.pluginAuthToken}`,
  );

  // Best-effort Headroom savings reporter — the long-lived serving daemon
  // funnels through start() (pair-auto→start, bare `codeam`→start, etc.), so
  // this is where the reporter must live for the SERVING daemon (pair-auto.ts
  // only covers the transient pairing process). Gated inside
  // maybeStartHeadroomReporter on HEADROOM_ENABLED==='1', which the backend
  // sets for PRO users and loadCodespaceEnv() restores into process.env at
  // boot — so the gate passes on the codespace daemon and is a no-op locally.
  // Skip entirely when pluginAuthToken is absent/empty: an empty token
  // guarantees a 401 on every savings POST (metering lost, 401-storm).
  const headroomReporter = session.pluginAuthToken
    ? maybeStartHeadroomReporter({
        sessionId: session.id,
        pluginId,
        pluginAuthToken: session.pluginAuthToken,
        codespaceId: process.env['CODESPACE_NAME'] ?? session.id,
      })
    : null;
  process.once('exit', () => {
    headroomReporter?.stop();
  });

  // On-demand LOCAL Headroom resume — additive to the codespace path above and
  // a strict no-op when HEADROOM_ENABLED==='1' (codespace/self-hosted). Local
  // on-demand never sets that env, so without this a CLI restart would stop
  // crediting savings until the user re-toggled Cost-saving. Reads the persisted
  // ~/.codeam/headroom-config.json and posts to the CURRENT session's endpoint.
  const localHeadroomReporter = session.pluginAuthToken
    ? maybeResumeLocalHeadroomReporter({
        sessionId: session.id,
        pluginId,
        pluginAuthToken: session.pluginAuthToken,
      })
    : null;
  process.once('exit', () => {
    localHeadroomReporter?.stop();
  });

  // Claude credential-sync — keep the VAULT current from THIS session's local
  // credential as Claude rotates its OAuth token (Anthropic single-use refresh
  // tokens), so a LATER deploy injects a currently-valid token instead of the
  // stale link-time snapshot ("Claude creds expired on a new deploy"). Gated to
  // Claude sessions with a plugin token. Fires once now → auto-captures for a
  // user who has a working session but no LinkedAgent ("No LinkedAgent for
  // claude_code"). The backend guards it (auto-create if missing, never clobber a
  // durable non-rotating setup-token), so it's safe to run on any session shape.
  const claudeCredentialSync =
    session.agent === 'claude' && session.pluginAuthToken
      ? startClaudeCredentialSync({
          sessionId: session.id,
          pluginId,
          pluginAuthToken: session.pluginAuthToken,
          pollSecret: session.pollSecret,
        })
      : null;
  process.once('exit', () => {
    void claudeCredentialSync?.stop();
  });

  // Cloud (codespace / self-hosted): pre-complete Claude's first-run onboarding
  // AND pre-accept the per-workspace "trust this folder?" dialog BEFORE anything
  // launches claude (the ACP agent + the `claude -p` preview prewarm). Without
  // this, Claude's interactive theme picker OR the fresh-dir trust safety dialog
  // stalls both — the ACP path has no `--dangerously-skip-permissions` to bypass
  // trust, so it streams as plain text mobile can't answer (2026-07-10 P0). No-op
  // for a local `codeam start` (the user's own onboarding + trust are already set).
  if (!isLocalSession()) ensureClaudeOnboarded(cwd);

  // Beads — composition-root concern (SRP decision D10), provisioned ONCE
  // here for BOTH the ACP and the PTY path. `start()` is the single funnel
  // for local `codeam start` AND codespace `pair-auto`→`start()`, so this
  // covers both. Fired (not awaited) so a slow bd provision never delays the
  // agent spawn; `provisionBeadsForStart` swallows every error and resolves
  // to null, so beads is strictly non-fatal and the agent runs regardless.
  // The live handle is exposed via `getBeads` (threaded into the ACP runner)
  // and `ctx.beads` (read by the PTY-path command handlers) so relayed
  // `beads_action` commands route into the orchestrator.
  let beads: StartedBeads | null = null;
  const getBeads = (): StartedBeads | null => beads;
  // STATIC "use bd" instruction — written synchronously NOW (before the agent
  // spawn, DB-independent) so the agent learns to use beads immediately even
  // though beads provisioning (below) is no longer gated. See ensureBeadsWorkflowHint.
  ensureBeadsWorkflowHint();
  // Always-on Agent Standard (baseline working + safety guidance) — Claude rail:
  // append to ~/.claude/CLAUDE.md so it's always in context. MANAGED deploys only
  // (a local `codeam start` keeps the user's own global config untouched); other
  // ACP agents get it as a one-time prompt preface in the runner. Best-effort.
  if (!isLocalSession() && session.agent === 'claude') {
    ensureAgentStandard();
  }
  const beadsReady = provisionBeadsForStart({
    sessionId: session.id,
    pluginId,
    pluginAuthToken: session.pluginAuthToken ?? undefined,
    cwd,
    // Wire this session's agent natively via `bd setup <recipe> --global` so
    // the agent actually uses bd (D12 — REVISED). Covers BOTH ACP and PTY.
    agents: [session.agent],
  }).then((started) => {
    beads = started;
    return started;
  });

  // Agent Toolkits — build the ACP `mcpServers` list from the integrations
  // manifest a deploy (or self-hosted `payload.integrations`) persisted to
  // `~/.codeam/integrations.json`. Pure/synchronous file work (no token
  // fetch — the `codeam mcp-run` shim brokers that lazily at its own spawn),
  // so unlike beads/deps it needs no gate; threaded into BOTH the plain ACP
  // path and the baton's mobile driver below.
  // Box-local custom MCP servers (`~/.codeam/mcp-servers.json`) — a
  // self-hosted box owner's own MCP config, merged in AFTER the integration
  // servers (integration wins on a name collision) so it always reaches the
  // agent even though `session/new` passes `mcpServers` explicitly and would
  // otherwise override whatever the agent's own native MCP config declares.
  const mcpServers = mergeWithLocalMcpServers(
    buildMcpServersForStart({
      sessionId: session.id,
      pluginId,
      pluginAuthToken: session.pluginAuthToken ?? undefined,
      pollSecret: session.pollSecret,
    }),
  );

  // Agent Skills — materialize any curated SKILL.md the deploy attached
  // (~/.codeam/skills.json) under $HOME before the agent spawns. Claude
  // discovers + hot-reloads them. Best-effort, never gated.
  provisionSkillsForStart();

  // Auto-provision the project's runtime deps (Postgres/Redis via the repo's
  // compose, or a heuristic one) so the dev server boots on the first preview.
  // CODESPACE ONLY — locally the user owns their own services. Fired in
  // PARALLEL with beads (both BEFORE the agent); strictly non-fatal. The heavy
  // part is a cold image pull, run at idle cpu/io priority (see
  // provisionProjectDependencies) — but the real OOM guard is the gate below:
  // the agent (the memory hog) only spawns AFTER this resolves, so the pull and
  // the agent never peak together (the v2.39.0 regression was the pull running
  // DURING the live agent). If a dep still isn't up, the preview error-card is
  // the safety net.
  const depsReady: Promise<void> =
    process.env.CODESPACES === 'true'
      ? provisionProjectDependencies(cwd).catch(() => undefined)
      : Promise.resolve();

  // Gate the agent spawn on dep provisioning + the agent binary — codespace only.
  // ⚠️ BEADS IS NO LONGER GATED (2026-07-25 speed fix). It used to block here so
  // bd's SessionStart `bd prime` hook landed before the agent inited (else the
  // agent "never learns to use bd" and writes files instead of `bd remember`).
  // But beads provisioning is ~20s of SEQUENTIAL Dolt startup (bd init → server →
  // DB — verified un-parallelizable) and it dominated the whole prebaked-image
  // deploy. The "learns to use bd" guarantee now comes from a STATIC bd-workflow
  // instruction written to `~/.claude/CLAUDE.md` synchronously BEFORE the agent
  // spawn (`ensureBeadsWorkflowHint`, below) — DB-INDEPENDENT, so the agent knows
  // to use bd the instant it spawns, and beads (server + DB + the dynamic
  // `bd prime` MEMORIES) finishes in the background (`beadsReady` still runs, just
  // isn't awaited here). A `bd` command in the first ~15s waits for the shared
  // server (reuse-if-running) rather than failing. (A runtime write, NOT a baked
  // file: the fleet box mounts a volume over /home/box that would shadow a bake.)
  // The docker pull is still gated (else it OOMs with the agent).
  // The onboarding welcome is published hardcoded by the runner, so this delays
  // ONLY the agent, never the welcome. Local `codeam start` keeps fire-and-forget.
  if (process.env.CODESPACES === 'true') {
    const GATE_TIMEOUT_MS = 240_000;
    // An agent's launch binary can still be installing when this gate
    // would otherwise release: on a fresh codespace the CLI, each agent's
    // binary (claude's ~250 MB SDK optional dep, `npm i -g @openai/codex`,
    // the cursor/gemini installers) all land concurrently. Spawning the
    // ACP adapter before its binary exists dies with a "binary not found"
    // error (2026-07-03 incident: claude's binary landed 25 s after the
    // agent tried to start). Each ACP adapter owns its own readiness
    // check (`waitForBinary`) — the gate just calls it. Resolves instantly
    // on the happy path (binary present); bounded by the gate timeout so a
    // stuck install can't wedge the session (agent spawns anyway and the
    // agent then emits its own actionable install error).
    // Two independent readiness checks for the ACP adapter, both bounded by the
    // gate: (1) its LAUNCH BINARY is on disk (claude's SDK native dep, codex,
    // …), and (2) the adapter's OWN bundled JS module graph resolves — on a
    // fresh codespace the adapter's nested node_modules (e.g. `zod`) can still
    // be mid-install when the gate would otherwise release, so `node <adapter>`
    // crashes at import with ERR_MODULE_NOT_FOUND / a truncated-file SyntaxError
    // → "Agent adapter exited unexpectedly (code=1)" (2026-07-06 incident).
    // waitForAdapterModuleGraph probes the graph by actually loading the adapter
    // and only releases once it resolves; both resolve instantly on the happy
    // path (already installed).
    // Resolve the gate's adapter through the SAME bounded retry the ACP
    // dispatch fork uses: a transient `getAcpAdapter` null (npm reinstall
    // race mid-rename/ETXTBSY) would otherwise leave `acpAdapterForGate`
    // null → both the waitForBinary AND waitForAdapterModuleGraph waits get
    // skipped and the gate releases early, exactly the readiness race the
    // gate exists to prevent. Guarded on `requiresAcp` so a non-ACP agent
    // (aider) still short-circuits to `Promise.resolve(true)` instead of
    // burning the retry budget on an id that has no adapter by design.
    const acpAdapterForGate = requiresAcp(session.agent)
      ? await resolveAcpAdapterWithRetry(session.agent)
      : null;
    const agentBinaryReady: Promise<unknown> = acpAdapterForGate
      ? Promise.all([
          acpAdapterForGate.waitForBinary({ timeoutMs: GATE_TIMEOUT_MS }).catch(() => false),
          waitForAdapterModuleGraph(acpAdapterForGate.command, acpAdapterForGate.args, {
            timeoutMs: GATE_TIMEOUT_MS,
          }).catch(() => false),
        ])
      : Promise.resolve(true);
    let gateTimer: ReturnType<typeof setTimeout> | undefined;
    // Beads intentionally EXCLUDED — it provisions in the background (static bd
    // instruction is baked into the image, so the agent learns bd without waiting).
    await Promise.race([
      Promise.all([depsReady, agentBinaryReady]),
      new Promise<void>((resolve) => {
        gateTimer = setTimeout(resolve, GATE_TIMEOUT_MS);
      }),
    ]);
    if (gateTimer) clearTimeout(gateTimer);
    log.info(
      'beads',
      `agent-spawn gate released (beads ungated, ${beads ? 'already ready' : 'still provisioning in background'}); project deps provisioned`,
    );
  }

  // ACP dispatch. Agents that ship an ACP adapter (claude / codex /
  // gemini today; more as vendors publish adapters) run over the typed
  // protocol UNCONDITIONALLY — it is their ONLY launch path. There is
  // no env flag and no PTY fallback for them: the legacy per-agent TUI
  // parsers were removed in the ACP-only cutover. The runner owns its
  // own lifecycle (signal handlers, relay, process.exit on shutdown),
  // so this branch never returns once ACP takes over.
  //
  // ACP requires a `pluginAuthToken` (every modern pair flow mints one).
  // If an adapter-backed agent somehow has no token we FAIL loudly
  // rather than silently degrade — falling back to PTY is impossible
  // now that the TUI spawn surface for these agents is gone.
  //
  // Agents WITHOUT an adapter (aider, cursor, coderabbit) keep using
  // the generic PTY runtime below.
  //
  // Keep the machine awake for the LIFETIME of this local session: a local
  // `codeam` session is a long-running process the paired mobile app talks to,
  // so an idle laptop going to sleep freezes it and drops the session until the
  // user physically wakes the machine. Hold an OS-native power assertion
  // (caffeinate / systemd-inhibit / SetThreadExecutionState) tied to this CLI
  // pid. No-op off a local session or an unsupported OS; auto-releases when the
  // CLI exits (even on a crash). (Edgar 2026-08-10.) Placed BEFORE every session
  // branch below so baton / ACP / PTY local sessions are all covered.
  const releaseKeepAwake = keepDeviceAwake();
  process.once('exit', releaseKeepAwake);

  // LOCAL session baton (local-only) — branches BEFORE the ACP fork so
  // codespaces/self-hosted fall through UNCHANGED. Only a local session
  // (`isLocalSession()`) with an ACP-capable agent takes this path; it
  // launches the native TUI and lets mobile take/return control over ACP.
  // The baton owns its own lifecycle and never returns, exactly like
  // `runAcpSession` below.
  if (isLocalSession() && requiresAcp(session.agent)) {
    // Resolve via the SAME bounded retry the main ACP fork uses — a
    // transient `getAcpAdapter` null (npm reinstall race) would otherwise
    // silently drop Take Control to the plain ACP path below instead of
    // waiting out the race and offering the baton.
    const adapter = await resolveAcpAdapterWithRetry(session.agent);
    // Only agents with a resumable transcript (claude/codex/cursor) get the
    // baton — otherwise the read-only mirror would be a silent no-op and Take
    // Control couldn't resume the conversation. Everything else falls through
    // to the plain ACP path below (no Take Control offered).
    const batonCapable = runtimeSupportsBaton(createRuntimeStrategy(session.agent));
    if (batonCapable && adapter && session.pluginAuthToken) {
      await runBatonSession({
        agent: session.agent,
        sessionId: session.id,
        pluginId,
        pluginAuthToken: session.pluginAuthToken,
        pollSecret: session.pollSecret,
        cwd,
        adapter,
        getBeads,
        mcpServers,
      });
      return; // baton owns the lifecycle
    }
  }

  if (requiresAcp(session.agent)) {
    let adapter = getAcpAdapter(session.agent);
    if (!adapter) {
      // `requiresAcp` is now STATIC (registry membership only — see
      // adapters.ts) so it never tells us resolution actually succeeded.
      // A `null` here means the adapter's module resolution is
      // currently failing — almost always transient (an npm reinstall
      // race mid-rename/ETXTBSY). Give it a bounded second chance
      // before treating the agent as unable to start; NEVER silently
      // fall through to the legacy PTY runtime below for an
      // ACP-required agent (the 2026-07-17 incident).
      adapter = await resolveAcpAdapterWithRetry(session.agent);
    }
    if (!adapter) {
      log.error(
        'acp',
        `[acp] REQUIRED adapter unresolvable — refusing PTY downgrade (agent=${session.agent})`,
      );
      const failureMsg =
        `${AGENT_REGISTRY[session.agent].displayName}'s ACP adapter is unavailable — ` +
        'the session cannot start; redeploy or retry.';
      if (session.pluginAuthToken) {
        // Bring the plugin online with a minimal relay and publish the
        // failure into chat — same standard failure-bubble path a live
        // ACP session uses when `client.start()` throws (see
        // `surfaceStartupFailure` in `agents/acp/runner.ts`). Without
        // this the app would just show a spinner forever.
        await surfaceStartupFailure({
          agent: session.agent,
          pluginId,
          detail: failureMsg,
          recentStderr: '',
          publisher: new AcpPublisher({
            sessionId: session.id,
            pluginId,
            pluginAuthToken: session.pluginAuthToken,
            refreshAuthToken: () =>
              fetchCurrentPluginAuthToken(session.id, pluginId, session.pollSecret),
          }),
          sessionId: session.id,
          pluginAuthToken: session.pluginAuthToken,
          pollSecret: session.pollSecret,
        });
        return;
      }
      // No token at all — nothing to authenticate a bubble POST with.
      // Fall back to the local terminal message (matches the pre-existing
      // "no token" behavior below).
      showError(failureMsg);
      process.exit(1);
    }
    if (!session.pluginAuthToken) {
      showError(
        `${AGENT_REGISTRY[session.agent].displayName} requires a paired session with an ` +
          'auth token. Re-pair with `codeam pair` to continue.',
      );
      process.exit(1);
    }
    await runAcpSession({
      agent: session.agent,
      sessionId: session.id,
      pluginId,
      pluginAuthToken: session.pluginAuthToken,
      adapter,
      cwd,
      getBeads,
      pollSecret: session.pollSecret,
      mcpServers,
      // AUTO mode for headless, mobile-driven sessions: no human at the box
      // to answer permission prompts, so auto-approve them rather than stall
      // the turn (the agent-agnostic equivalent of
      // --dangerously-skip-permissions). Both surfaces qualify — a GitHub
      // Codespace (`CODESPACES=true`) and a self-hosted deploy (the host-agent
      // sets `CODEAM_AUTO_APPROVE=1` on the pair-auto child).
      autoApprovePermissions:
        process.env.CODESPACES === 'true' || process.env.CODEAM_AUTO_APPROVE === '1',
    });
    return;
  }

  // Defense in depth: the block above always `return`s for an ACP-required
  // agent, so this line should be unreachable for one. If a future
  // refactor ever reintroduces a fall-through, log loudly rather than
  // silently spawning the legacy PTY runtime for an agent that must run
  // over ACP (the exact shape of the 2026-07-17 incident).
  if (requiresAcp(session.agent)) {
    log.error('acp', `[anomaly] acp-required agent on PTY runtime (agent=${session.agent})`);
  }
  const runtime = createRuntimeStrategy(session.agent);
  // SEC crit1 (#819): pass the per-pairing token so conversation-history
  // writes carry X-Plugin-Auth-Token for the backend to authorize.
  const historySvc = new HistoryService(runtime, pluginId, cwd, {
    pluginAuthToken: session.pluginAuthToken,
  });

  const keepAliveCtx = {
    inCodespace: process.env.CODESPACES === 'true',
    codespaceName: process.env.CODESPACE_NAME,
  };
  const { apply: setKeepAlive } = buildKeepAlive(keepAliveCtx);

  // Default-ON inside a codespace. Earlier the keep-alive only
  // engaged when the user explicitly flipped the "Avoid suspend"
  // toggle from the mobile/web Settings modal — so fresh codespaces
  // inherited GitHub's 30-min idle window and the in-codespace
  // `codeam` / `claude` processes died on the first long pause,
  // leaving the dashboard's next `list_files` / `terminal_open`
  // command stranded against a session whose plugin was gone.
  // Calling `setKeepAlive(true)` at startup PATCHes
  // `idle_timeout_minutes=240` (the GitHub max) and re-applies
  // every 30 min. Outside a codespace the call is a no-op — the
  // ctx guard inside `buildKeepAlive` short-circuits.
  if (keepAliveCtx.inCodespace) {
    setKeepAlive(true);
  }

  const outputSvc = new OutputService(
    session.id,
    pluginId,
    (conversationId) => historySvc.setCurrentConversationId(conversationId),
    (reset) => historySvc.setRateLimitReset(reset),
    () => {
      // Refresh the quota cache when stale (30 min TTL) and ship the
      // delta of the just-finished turn so the SSE consumers can
      // fetch the canonical markdown via `?last=1` and replace the
      // streamed PTY approximation with proper ``` fences / blocks.
      if (historySvc.isQuotaStale()) fetchQuotaUsage(runtime, historySvc);
      setTimeout(() => {
        historySvc.uploadDelta().catch(() => { /* best-effort */ });
      }, 400);
      // End-of-turn file changeset — fire-and-forget. The aggregator
      // owns its own outbox + retry so this never throws.
      turnFiles?.flushTurn().catch(() => { /* logged inside */ });
    },
    () => {
      // Terminal-initiated turn — the user typed directly in their
      // local terminal. Wait for Claude Code to flush the user
      // message into the JSONL, then start the relay turn with:
      // clear → user_message → new_turn → response.
      //
      // On timeout / error: do NOT open a turn. The detection
      // fires on the first printable byte after the buffer
      // deactivates, which Claude's ghost-text completion (painted
      // 300-500 ms after the previous turn settles) trips before
      // the user actually types. Calling `startTerminalTurn` with
      // no userText would emit `clear` + `new_turn`, activate the
      // PTY buffer, and the tick poll would render the still-
      // visible previous response as fresh `text` chunks → a
      // duplicate agent bubble on mobile. Resetting the gate
      // instead lets the next legitimate keystroke re-fire
      // detection cleanly.
      const prevCount = historySvc.getCurrentMessageCount();
      historySvc.waitForNewUserMessage(prevCount)
        .then((userText) => {
          if (userText) {
            void outputSvc.startTerminalTurn(userText);
          } else {
            outputSvc.resetTerminalTurnGate();
          }
        })
        .catch(() => outputSvc.resetTerminalTurnGate());
    },
    session.pluginAuthToken,
    runtime,
  );

  // Shared dirty-flag tracker — the file-watcher writes (per event,
  // after walk-up), the aggregator reads + clears (per done:true).
  // Skipping `git status` on chat-only turns is the headline win;
  // multi-repo workspaces where the agent touches a single sub-repo
  // also stop scanning the untouched siblings.
  const dirtyTracker = session.pluginAuthToken ? new RepoDirtyTracker() : null;

  // File-change producer — emits `/api/files/changed` + `/api/review/hunks`
  // on every modified file under `cwd` for the duration of the session.
  // No-op when `pluginAuthToken` is missing (older paired sessions from
  // before the rolling-token rollout — they can't authenticate against
  // the file endpoints anyway). Best-effort lifecycle: any error inside
  // the watcher is logged via `log.warn` and never blocks the agent.
  const fileWatcher = session.pluginAuthToken
    ? new FileWatcherService({
        workingDir: cwd,
        sessionId: session.id,
        pluginId,
        pluginAuthToken: session.pluginAuthToken,
        onRepoDirty: dirtyTracker
          ? (repoRoot) => dirtyTracker.markDirty(repoRoot)
          : undefined,
      })
    : null;

  // End-of-turn aggregator — discovers every git repo under `cwd`
  // at startup and, on each `done:true`, runs `git status` +
  // `git diff --numstat` ONCE per repo to build a batch POST. Local
  // outbox covers transient failures with exponential backoff.
  // Replaces the legacy per-file fan-out for the rail / drawer; the
  // chokidar watcher stays alive (its upserts are idempotent against
  // the same composite key) until we're confident enough to remove
  // it in a follow-up.
  const turnFiles = session.pluginAuthToken
    ? new TurnFileAggregator({
        workingDir: cwd,
        sessionId: session.id,
        pluginId,
        pluginAuthToken: session.pluginAuthToken,
        agentId: runtime.meta.id,
        dirtyTracker: dirtyTracker ?? undefined,
      })
    : null;

  // Epic C streaming producer — parses Claude/Codex PTY output into
  // discriminated chunks and pushes them to the backend for the
  // mobile/web live-view, and detects React Ink interactive prompts to
  // surface as "awaiting answer" on the mobile side. Same auth gate as
  // the file-watcher: a session paired before the rolling-token
  // rollout has no `pluginAuthToken` and can't authenticate against
  // the Epic C endpoints, so we skip the producer for those.
  // Late-bound so the closure can reach `claude` for the answer path.
  let streamingEmitter: StreamingEmitterService | null = null;

  // `beads` (the live handle) + `getBeads` are owned by the composition-root
  // provisioning above; the teardown closures (onExit / sigintHandler) and
  // `ctx.beads` below read that shared handle.

  const agent = new AgentService(
    runtime,
    {
      cwd,
      onData(raw) {
        outputSvc.push(raw);
        streamingEmitter?.push(raw);
      },
      onExit(code) {
        process.removeListener('SIGINT', sigintHandler);
        process.removeListener('SIGTERM', sigintHandler);
        process.removeListener('SIGHUP', sigintHandler);
        outputSvc.dispose();
        relay.stop();
        void fileWatcher?.stop();
        turnFiles?.stop();
        void beads?.watcher.stop();
        void streamingEmitter?.stop();
        // Close every IDE terminal spawned during the session so the
        // child shells don't get orphaned past the parent exit
        // (audit R11 — closeAllTerminals existed but was never
        // called).
        closeAllTerminals();
        // Eagerly delete in-flight attachment temp files instead of
        // waiting on the 120 s unlink setTimeout (audit R12).
        cleanupAttachmentTempFiles();
        // Same reaper as the sigintHandler — reap any in-flight
        // `claude -p` / `codex exec` headless children so they
        // don't survive the parent's hard `process.exit`.
        killActiveSpawnAndCaptureChildren();
        process.exit(code);
      },
    },
  );

  if (session.pluginAuthToken) {
    streamingEmitter = new StreamingEmitterService({
      sessionId: session.id,
      pluginId,
      pluginAuthToken: session.pluginAuthToken,
      runtime,
      ptyInput: agent,
    });
  }

  // Built EARLY so the closure inside `relay`'s onCommand below has
  // a stable reference. Filled in once the dependent services exist.
  const ctx: HandlerContext = {
    outputSvc,
    agent,
    historySvc,
    runtime,
    relay: undefined as unknown as CommandRelayService,
    setKeepAlive,
    keepAliveCtx,
    pluginId,
    sessionId: session.id,
    agentId: session.agent,
    pluginAuthToken: session.pluginAuthToken ?? undefined,
  };

  const relay = new CommandRelayService(pluginId, async (cmd) => {
    await dispatchCommand(ctx, cmd);
  }, runtime.meta);
  ctx.relay = relay;

  // Expose the composition-root-provisioned Beads handle on `ctx` once it
  // resolves, so the PTY-path command handlers route relayed `beads_action`
  // commands into the orchestrator. Provisioning was kicked off above (before
  // the ACP fork); this only forwards its result onto the handler context.
  void beadsReady.then((started) => {
    ctx.beads = started;
  });

  // Wire the IDE terminal handlers so PTY data + exit events stream
  // back to the IDE client via the same SSE chunk channel chat uses.
  // The handler module keeps its own session map; we just forward
  // the pushes through outputSvc.
  registerTerminalHandlers({
    onData: ({ sessionId, data }) => {
      void outputSvc.sendTerminalChunk(sessionId, data);
    },
    onExit: ({ sessionId, exitCode }) => {
      void outputSvc.sendTerminalExit(sessionId, exitCode);
    },
  });

  // Re-entry guard — SIGHUP can fire repeatedly during a clean
  // terminal close. Only run the cleanup once.
  let shuttingDown = false;
  async function sigintHandler(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    agent.kill();
    outputSvc.dispose();
    relay.stop();
    void fileWatcher?.stop();
    void beads?.watcher.stop();
    void streamingEmitter?.stop();
    // IDE terminals (`openTerminal()` sessions) outlive the agent's
    // PTY by design — but on hard exit we need to reap their child
    // shells too. closeAllTerminals() is the public reaper; it's
    // safe to call when no terminals are open. Audit R11.
    closeAllTerminals();
    // Drain attachment temp files registered by start_task. The
    // 120 s setTimeout cleanup in handlers.ts only fires if the
    // process survives that long — under Ctrl+C we'd leak.
    cleanupAttachmentTempFiles();
    // Reap any in-flight `claude -p` / `codex exec` headless
    // children spawned by the AI summary/insight handlers. Without
    // this they'd get re-parented to init and keep running for up
    // to 60 s after the user hits Ctrl-C — a small leak but a
    // visible one if you have `pgrep claude` in your habits.
    killActiveSpawnAndCaptureChildren();

    // ── In-app preview shutdown — graceful, awaited ────────────────
    // The previous `void killAllPreviews()` was fire-and-forget +
    // `process.exit(0)` immediately after. killPreview has a 100 ms
    // SIGTERM grace window inside it; process.exit aborted the
    // event loop before that microtask ran, so the dev server +
    // tunnel were never sent SIGTERM. They got re-parented to launchd
    // and kept running long after the CLI exited.
    //
    // Snapshot the active session ids BEFORE the kill drains the
    // registry, then emit `preview_stopped` to the backend per
    // session AFTER the locals are reaped so the mobile / web
    // PreviewTab returns to idle without waiting for the 1 h Redis
    // TTL to expire. Both awaited — process.exit waits for them.
    const previewSessionIds = activePreviewSessionIds();
    try {
      await killAllPreviews();
    } catch {
      // best-effort — the SIGKILL safety timer inside killPreview
      // still fires regardless of any await rejection here.
    }
    const previewAuthToken = session?.pluginAuthToken;
    if (previewAuthToken && previewSessionIds.length > 0) {
      await Promise.allSettled(
        previewSessionIds.map((sid) =>
          postPreviewEvent({
            sessionId: sid,
            pluginId,
            pluginAuthToken: previewAuthToken,
            type: 'preview_stopped',
            payload: { reason: 'session_end' },
          }),
        ),
      );
    }

    // Best-effort flush of queued telemetry. fire-and-forget so
    // process.exit doesn't wait — the SDK already batches +
    // sends opportunistically.
    void shutdownTelemetry();
    process.exit(0);
  }

  // SIGINT (Ctrl+C) is the primary interrupt; SIGTERM + SIGHUP fire
  // on terminal close / `kill <pid>` / parent-shell exit and were
  // previously unhandled — the backend kept showing the session as
  // online for ~30 s until heartbeat-timeout (audit R12 / F11).
  // Node's signal listeners want `() => void`; our async handler
  // returns Promise<void>. `void sigintHandler()` discards the
  // returned promise — but `await`-ing inside the handler before
  // process.exit IS what guarantees `killAllPreviews` finishes.
  process.once('SIGINT', sigintHandler);
  process.once('SIGTERM', sigintHandler);
  process.once('SIGHUP', sigintHandler);
  // Spawn Claude FIRST so its strategy is set + the PTY is launching
  // before the relay starts dispatching remote commands.
  await agent.spawn();
  // Bind the conversation id now if the runtime pre-assigned it via
  // `prepareLaunch` (Claude: `--session-id <uuid>`). Deterministic
  // across every OS — we never have to inspect the filesystem to
  // figure out which JSONL Claude is using. Runtimes that don't
  // pre-assign (Codex, Aider, …) keep using the
  // detectCurrentConversation birthtime fallback.
  const spawnedSessionId = agent.spawnedSessionId;
  if (spawnedSessionId) {
    historySvc.setCurrentConversationId(spawnedSessionId);
  }
  // Eagerly activate the output stream BEFORE the relay starts so
  // Claude's startup screen reaches the mobile / landing client. The
  // trust-this-folder dialog (and any other first-run interactive
  // selector) renders within the first second of `claude` boot — if
  // the OutputService is still inactive, those bytes get dropped at
  // `pty-buffer.push()` and the user is stranded looking at a blank
  // chat with no way to acknowledge the dialog. Calling
  // `startTerminalTurn` here is the same code path used when the
  // human types directly in the local terminal: emits `clear` +
  // `new_turn`, activates the buffer, and tick() picks up the
  // selector that's already on screen.
  await outputSvc.startTerminalTurn();
  relay.start();

  // Kick off the file-change watcher last — never awaits, never blocks
  // the agent on a chokidar load hiccup. Failures are surfaced via the
  // logger and silently leave the file-change pipeline disabled for
  // this session.
  if (fileWatcher) {
    fileWatcher.start().catch(() => { /* logged inside */ });
  }

  // Epic C streaming producer — start after the relay so the PTY pump
  // is already wired before the emitter begins POSTing chunks. We
  // start unconditionally when present; lifecycle is owned by SIGINT /
  // onExit above.
  streamingEmitter?.start();

  // After Claude is up, load the local history index so the
  // /sessions surface (list of past conversations) is ready to
  // serve. We deliberately DO NOT auto-detect + upload "the most
  // recently modified JSONL" here: on a freshly paired CLI in a
  // directory that already has prior Claude history, that would
  // publish a stale conversation as the session's "active" one
  // and the mobile / web chat would render an old conversation
  // as if it were the new session's content. `uploadDelta()`
  // lazy-detects when Claude actually writes a turn (real
  // interaction), so the conversation id gets set the right way
  // — only after the user has engaged with the session, never
  // because a leftover JSONL happens to exist on disk.
  setTimeout(() => {
    historySvc.load().catch(() => {});
  }, 2000);
  setTimeout(() => fetchQuotaUsage(runtime, historySvc), 5000);
}
