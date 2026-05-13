import * as p from '@clack/prompts';
import pc from 'picocolors';
import { AGENT_REGISTRY } from '@codeagent/shared';
import { PROVIDERS } from '../services/providers';
import type { CloudProvider, DeployableProject, ExistingWorkspace, Workspace } from '../services/providers';
import { parseAgentFlag, promptForAgent } from '../utils/agent-prompt';
import { createDeployStrategy } from '../agents/registry';
import { loadCliConfig } from '../config';

// NOTE — Phase 1 uses `codeam pair --agent=<id>` for local deploy pairing
// (interactive QR flow on the remote workspace, agent flag carries the local choice).
// Phase 2 may switch to `codeam pair-auto` when a `codeam login` command is added
// that stores a user-JWT — at that point the CLI can call POST /api/pairing/mint-auto-token
// (already implemented server-side) to get a one-shot token instead of running
// the manual QR flow on the codespace.

/**
 * `codeam deploy` — provision a fresh cloud workspace, install the
 * agent CLI inside it, copy the user's local agent config so they
 * don't have to re-auth, and finish by streaming `codeam pair-auto`
 * from the workspace so the phone pairs automatically without an
 * interactive QR flow on the codespace.
 *
 * The orchestrator is provider-agnostic — it only talks through the
 * `CloudProvider` interface — so adding new backends (Gitpod, Coder,
 * etc.) is one new file in `services/providers/`.
 *
 * @param args - Raw CLI argv slice (e.g. `['--agent=claude']`).
 */
export async function deploy(args: string[] = []): Promise<void> {
  console.log();
  p.intro(pc.bgMagenta(pc.white(' codeam deploy ')));

  const provider = await pickProvider();
  if (!provider) {
    p.cancel('No provider selected.');
    process.exit(0);
  }

  // Step 1 — Authorize. We deliberately do NOT wrap this in a clack
  // spinner: `authorize()` may shell out to interactive subprocesses
  // (`gh auth login`, `gh auth refresh`, `brew install gh`) whose
  // device-flow prompts ("Press Enter to open in browser…") need to
  // own the last line of the terminal. A spinner running above keeps
  // re-drawing and hides the prompt, so the user thinks the run hung.
  p.log.step(`Authorizing with ${provider.displayName}…`);
  try {
    await provider.authorize();
    p.log.success(`Authorized with ${provider.displayName}`);
  } catch (err) {
    p.log.error('Authorization failed');
    p.cancel(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Step 2 — List + pick project. Wrapped in a loop so the user can
  // ask the provider to "expand list scopes" (e.g. add `read:org`
  // on GitHub) when their target repo isn't visible — common when
  // the user's account belongs to orgs / teams that the default
  // OAuth scope doesn't expose. Picking the magic "+ Don't see your
  // project?" entry triggers `provider.expandListScopes()` and the
  // loop re-fetches.
  const EXPAND_SCOPES = '__expand_scopes__';
  let project: DeployableProject | null = null;
  while (!project) {
    const listStep = p.spinner();
    listStep.start('Loading your projects…');
    let projects: DeployableProject[] = [];
    try {
      projects = await provider.listProjects();
      listStep.stop(`✓ ${projects.length} project${projects.length === 1 ? '' : 's'} available`);
    } catch (err) {
      listStep.stop(`✗ Could not list projects`);
      p.cancel(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const options = projects.slice(0, 50).map((proj) => ({
      value: proj.id,
      label: proj.fullName,
      hint: proj.description ? proj.description.slice(0, 80) : (proj.private ? 'private' : 'public'),
    }));
    if (provider.expandListScopes) {
      options.push({
        value: EXPAND_SCOPES,
        label: pc.cyan("+ Don't see your project? Expand scopes…"),
        hint: 'Re-authorize with broader scopes (org / team repos)',
      });
    }
    if (options.length === 0) {
      p.cancel('No projects found on the account.');
      process.exit(0);
    }

    const projectId = await p.select<string>({
      message: 'Select a project to deploy:',
      options,
    });
    if (p.isCancel(projectId) || typeof projectId !== 'string') {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    if (projectId === EXPAND_SCOPES) {
      try {
        await provider.expandListScopes!();
      } catch (err) {
        p.log.warn(err instanceof Error ? err.message : String(err));
      }
      // Loop iterates → re-fetch projects with the new scopes.
      continue;
    }
    project = projects.find((proj) => proj.id === projectId) ?? null;
  }

  // Step 3a — Reuse or create new? If the provider lists existing
  // workspaces and the user already has one (or several) for this
  // project, it would be wasteful to silently spin up another — most
  // re-runs of `codeam deploy` are intentional follow-ups on the
  // same project. Offer a picker so the user can pick up where they
  // left off; selecting "create new" continues the original flow.
  let workspace: Workspace | null = null;
  if (provider.listExistingWorkspaces && provider.startWorkspace) {
    const existingStep = p.spinner();
    existingStep.start('Checking for existing workspaces…');
    let existing: ExistingWorkspace[] = [];
    try {
      existing = await provider.listExistingWorkspaces(project.id);
      existingStep.stop(
        existing.length === 0
          ? '· No existing workspaces — will create a fresh one'
          : `✓ ${existing.length} existing workspace${existing.length === 1 ? '' : 's'} found`,
      );
    } catch {
      existingStep.stop('· Could not list existing workspaces — will create a fresh one');
    }

    if (existing.length > 0) {
      const choice = await p.select<string>({
        message: 'Reuse an existing workspace or create a new one?',
        options: [
          ...existing.map((w) => ({
            value: w.id,
            label: w.displayName ?? w.id,
            hint: [w.state, formatLastUsed(w.lastUsedAt)].filter(Boolean).join(' · '),
          })),
          { value: '__new__', label: pc.green('+ Create a new workspace'), hint: 'fresh codespace' },
        ],
      });
      if (p.isCancel(choice)) {
        p.cancel('Cancelled.');
        process.exit(0);
      }
      if (choice !== '__new__') {
        const reuseStep = p.spinner();
        const picked = existing.find((w) => w.id === choice)!;
        const needsStart = picked.state && picked.state !== 'Available';
        reuseStep.start(needsStart ? `Starting ${picked.displayName ?? picked.id}…` : `Connecting to ${picked.displayName ?? picked.id}…`);
        try {
          workspace = await provider.startWorkspace(picked.id);
          reuseStep.stop(`✓ Reusing ${workspace.displayName ?? workspace.id}`);
        } catch (err) {
          reuseStep.stop('✗ Could not start the existing workspace');
          p.cancel(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      }
    }
  }

  // Step 3b — Pick a machine type (only if we're creating new and the
  // provider exposes them). We hide options under 8 GB RAM in the
  // provider — Claude Code's tools (tsc, test runners, dev servers)
  // need headroom and the 4 GB tier tends to swap badly. The user
  // picks from what's left, defaulting to the smallest 8 GB option.
  let machineTypeId: string | undefined;
  if (!workspace && provider.listMachineTypes) {
    const machineStep = p.spinner();
    machineStep.start('Loading machine types…');
    let machines: Awaited<ReturnType<NonNullable<CloudProvider['listMachineTypes']>>> = [];
    try {
      machines = await provider.listMachineTypes(project.id);
      machineStep.stop(
        machines.length > 0
          ? `✓ ${machines.length} machine type${machines.length === 1 ? '' : 's'} available`
          : '· No machine types reported (using provider default)',
      );
    } catch {
      machineStep.stop('· Could not list machine types — using provider default');
    }
    if (machines.length >= 1) {
      // Always show the picker, even with a single option, so the
      // user sees the specs of what they're about to deploy. Orgs
      // commonly restrict their members to a single machine class
      // (the smallest tier) and silently auto-picking it left the
      // user wondering "what did I just create?".
      const picked = await p.select<string>({
        message: machines.length === 1
          ? 'Confirm machine size (only one is available for this project):'
          : 'Pick a machine size (starts at 8 GB RAM):',
        initialValue: machines[0].id,
        options: machines.map((m) => ({
          value: m.id,
          label: m.label,
          hint: `${m.memoryGb} GB RAM`,
        })),
      });
      if (p.isCancel(picked)) {
        p.cancel('Cancelled.');
        process.exit(0);
      }
      machineTypeId = picked;
    }
  }

  // Step 3c — Create workspace (only if we're not reusing one).
  if (!workspace) {
    const createStep = p.spinner();
    createStep.start(`Creating workspace for ${project.fullName}…`);
    try {
      workspace = await provider.createWorkspace(project.id, machineTypeId);
      createStep.stop(`✓ Workspace ready: ${workspace.displayName ?? workspace.id}`);
    } catch (err) {
      createStep.stop(`✗ Workspace creation failed`);
      p.cancel(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  // Agent picker — after workspace is ready so the user has context
  // for which provider/workspace they're configuring. Skips the prompt
  // when `--agent=<id>` was passed or when only one agent is enabled
  // (Phase 1: Claude only).
  const cfg = loadCliConfig();
  const agentId = parseAgentFlag(args) ?? await promptForAgent(cfg.preferredAgent ?? 'claude');
  const strategy = createDeployStrategy(agentId);

  // Step 4 — Detect + (optionally) bridge local credentials. We
  // could silently bridge to the workspace, but that assumes the user
  // wants the SAME account on the cloud agent — plenty of users
  // explicitly want a different one (work vs. personal account, a
  // sandbox account, etc.).
  //
  // Only ask when there's something we COULD bridge. If yes, confirm
  // with the user (default: yes — the common "skip re-auth" pitch).
  // If they say no, we skip the bridge and the verify step inside
  // strategy.setupOnWorkspace() will route them through interactive
  // agent login with whatever account they want.
  const localCreds = await strategy.detectLocalCredentials();
  let bridged: 'flat-file' | 'macos-keychain' | 'env-var' | 'none' = 'none';

  if (localCreds.source !== 'none') {
    const useLocal = await p.confirm({
      message: `Copy your local ${AGENT_REGISTRY[agentId].displayName} credentials (${localCreds.description}) to the workspace?`,
      active: 'Yes — same account, no re-auth',
      inactive: 'No — log in with a different account',
      initialValue: true,
    });
    if (p.isCancel(useLocal)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    if (useLocal) {
      // Pre-stage credentials BEFORE install. The order matters:
      // the agent's install.sh launches the agent binary once during
      // setup, and that first invocation persists "first-launch" state
      // files that can ignore credentials written afterward. Writing
      // creds first means the first run already sees a logged-in user
      // and skips the first-launch UX entirely.
      const credStep = p.spinner();
      credStep.start(`Bridging ${AGENT_REGISTRY[agentId].displayName} credentials…`);
      const result = await strategy.bridgeLocalCredentials(provider, workspace.id);
      bridged = result.source;
      credStep.stop(`✓ Credentials staged (${bridged})`);
    }
  }

  // Step 5 — Install agent CLI + copy config + verify auth + fallback
  // login. All of this is now owned by the strategy so that new agents
  // (Codex, Copilot, …) can plug in without touching deploy.ts.
  await strategy.setupOnWorkspace(provider, workspace.id, { bridged });

  // Step 6 — Install codeam-cli in the workspace so we can pair.
  const cliStep = p.spinner();
  cliStep.start('Installing codeam-cli on workspace…');
  const cliInstall = await provider.exec(workspace.id, 'npm install -g codeam-cli@latest');
  if (cliInstall.code !== 0) {
    cliStep.stop('✗ codeam-cli install failed');
    p.cancel(cliInstall.stderr.slice(0, 1000));
    process.exit(1);
  }
  cliStep.stop('✓ codeam-cli installed');

  // Step 7 — Start `codeam pair --agent=<id>` on the workspace via PM2.
  // Phase 1: the interactive QR flow runs on the codespace; the user scans
  // with their phone to pair. The agent flag carries the local selection so
  // the saved session on the codespace knows which agent to spawn — no API
  // token mint needed.
  p.note(
    [
      `Workspace: ${pc.cyan(workspace.displayName ?? workspace.id)}`,
      workspace.webUrl ? `Web:       ${pc.cyan(workspace.webUrl)}` : '',
      '',
      `Starting \`codeam pair\` on the workspace (agent: ${AGENT_REGISTRY[agentId].displayName}).`,
      'Scan the QR code from your phone to pair.',
      pc.dim('(Once paired, this terminal disconnects automatically; the session stays alive on the codespace.)'),
    ]
      .filter(Boolean)
      .join('\n'),
    'Almost there',
  );

  // After the agent is set up, run `codeam pair --agent=<id>` on the workspace
  // via PM2 — a battle-tested Node.js process manager whose god-daemon
  // survives SSH session cleanup on Codespaces (where nohup, setsid
  // and tmux all fail). PM2 owns the lifecycle: spawn, restart on
  // crash, log redirection, graceful stop.
  //
  // The wrapper:
  //   1. Installs PM2 if missing (idempotent first-run setup).
  //   2. `pm2 start codeam --name codeam-pair -- pair --agent=<id>`
  //      with merged stdout/stderr piped to a session log.
  //   3. Tails the log locally so the QR code + "Paired with" marker render.
  //   4. Phase 1: wait for "Paired with"; phase 2: wait for "for shortcuts"
  //      so any first-time agent prompts get answered on the phone before
  //      we close locally.
  //   5. Local Ctrl+C kills only the local tail — PM2 keeps the relay
  //      running.
  const wrapper = [
    'mkdir -p ~/.codeam-deploy',
    'LOG=~/.codeam-deploy/session.log',
    ': > "$LOG"',
    // The default `gh codespace ssh` cwd is the repo root
    // (/workspaces/<repo>), which is exactly where the agent needs to
    // run so it can read/edit project files. Pass that to PM2 via
    // --cwd so the relay's child agent inherits the right directory.
    'PROJECT_DIR="$(pwd)"',
    // Install PM2 if it isn't already on PATH. Idempotent.
    'if ! command -v pm2 >/dev/null 2>&1; then',
    '  echo "Installing pm2 (one-time setup)…"',
    '  npm install -g pm2 >/dev/null 2>&1 || { echo "✗ Failed to install pm2"; exit 1; }',
    'fi',
    // Stop any prior codeam-pair instance — fresh start each deploy.
    'pm2 delete codeam-pair >/dev/null 2>&1',
    // Start codeam pair under PM2. `--merge-logs` writes stdout
    // and stderr to the same file so we only need one tail.
    // --max-restarts 3 keeps PM2 from looping forever if codeam pair
    // can't start (e.g. backend unreachable) — three attempts is enough
    // for transient flakes.
    // No `--time` (would prefix every line with a timestamp); no
    // `--no-pmx` either (default off).
    `pm2 start codeam --name codeam-pair --cwd "$PROJECT_DIR" --max-restarts 3 -o "$LOG" -e "$LOG" --merge-logs -- pair --agent=${agentId} >/dev/null 2>&1`,
    // Give PM2 a moment to spawn the process before we start polling
    // status — otherwise the very first jlist can race the spawn.
    'sleep 2',
    // Filter the live tail: PM2 captures stdout to a file, so codeam-
    // cli's spinner (which uses \r to redraw a single line in a TTY)
    // becomes hundreds of new "Waiting for mobile app" / "Requesting
    // pairing code" lines per second in the file — pure noise. Drop
    // them so the user sees just the QR + the pairing code + the
    // "Paired with" / "for shortcuts" markers.
    // `tail -n +1` shows everything in the file from the start —
    // critical because pm2 has already written the QR + pairing
    // code by the time we get here (during the `sleep 2` above).
    // `-n 0` would miss all of that and only show the post-spawn
    // spinner spam, leaving the user staring at a blank screen.
    'tail -n +1 -F "$LOG" 2>/dev/null | grep --line-buffered -vE "Waiting for mobile app|Requesting pairing code" &',
    'TAIL=$!',
    "trap 'kill $TAIL 2>/dev/null; exit 130' INT TERM",
    // Phase 1 — wait for "Paired with", or for codeam to print a
    // recognisable failure, or for PM2 to report the process gone.
    'SUCCESS=0',
    'FAIL_REASON=""',
    'while true; do',
    '  if grep -q "Paired with" "$LOG" 2>/dev/null; then SUCCESS=1; break; fi',
    // Detect specific codeam error messages early so the user gets
    // an actionable message instead of a generic "did not start".
    '  if grep -q "Could not reach the server" "$LOG" 2>/dev/null; then',
    '    FAIL_REASON="codeam could not reach the CodeAgent backend (network/firewall? Vercel bot-challenge on the API?)"',
    '    SUCCESS=0; break',
    '  fi',
    '  if grep -qE "Pairing timed out|Failed to" "$LOG" 2>/dev/null; then',
    '    FAIL_REASON="$(grep -E "Pairing timed out|Failed to" "$LOG" | head -1)"',
    '    SUCCESS=0; break',
    '  fi',
    // Status check: parse PM2 jlist via Python (every codespace has
    // python3) for resilient JSON handling, instead of fragile grep.
    '  ALIVE=$(pm2 jlist 2>/dev/null | python3 -c "import json,sys',
    'try:',
    '  d=json.load(sys.stdin)',
    "  it=[x for x in d if x.get('name')=='codeam-pair']",
    "  print(it[0]['pm2_env']['status'] if it else 'missing')",
    'except Exception:',
    "  print('parse-error')" + '" 2>/dev/null)',
    '  case "$ALIVE" in',
    '    online|launching) ;;',  // still good
    '    "")',
    '      FAIL_REASON="PM2 not responding"',
    '      SUCCESS=0; break ;;',
    '    missing|stopped|errored|stopping)',
    '      FAIL_REASON="PM2 reports codeam-pair is $ALIVE"',
    '      SUCCESS=0; break ;;',
    '  esac',
    '  sleep 1',
    'done',
    'if [ "$SUCCESS" = "1" ]; then',
    '  echo',
    '  echo "✓ Phone paired."',
    '  echo "  Answer any first-time prompts (\"trust this folder\", etc.) on your phone."',
    '  echo "  Local terminal will close once Claude is ready."',
    '  echo',
    // Phase 2 — wait for the Claude "ready" marker.
    '  WAIT_START=$(date +%s)',
    '  while true; do',
    '    if grep -q "for shortcuts" "$LOG" 2>/dev/null; then break; fi',
    '    if [ $(($(date +%s) - WAIT_START)) -gt 180 ]; then break; fi',
    '    sleep 1',
    '  done',
    'fi',
    'trap - INT TERM',
    'kill $TAIL 2>/dev/null',
    'echo',
    'if [ "$SUCCESS" = "1" ]; then',
    '  echo "✓ Session running via PM2 on the codespace. Closing local connection — your phone stays paired."',
    '  echo "  To stop later: gh codespace ssh -- pm2 delete codeam-pair"',
    '  exit 0',
    'else',
    '  echo "✗ Pairing did not complete."',
    '  if [ -n "$FAIL_REASON" ]; then echo "  Reason: $FAIL_REASON"; fi',
    '  echo',
    '  echo "  Last log lines from codeam pair:"',
    '  tail -n 8 "$LOG" 2>/dev/null | sed "s/^/    /"',
    '  pm2 delete codeam-pair >/dev/null 2>&1',
    '  exit 1',
    'fi',
  ].join('\n');

  const code = (
    await provider.streamCommand(workspace.id, `bash -lc ${shellQuoteSingle(wrapper)}`)
  ).code;
  if (code === 0) {
    p.outro(pc.green('✓ Workspace deployed and paired. Drive from your phone, anywhere.'));
  } else if (code === 130) {
    p.outro(pc.yellow('Disconnected from local terminal. Mobile session keeps running on the codespace.'));
  } else {
    p.outro(pc.yellow('Pairing did not complete. Run "codeam pair" inside the codespace if needed.'));
  }
}

function shellQuoteSingle(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render an ISO timestamp as a short relative string ("3 days ago",
 * "5 minutes ago"). Used in the "reuse vs. create" picker to give the
 * user a quick sense of which existing workspace is the recent one.
 */
function formatLastUsed(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diffMs = Date.now() - t;
  if (diffMs < 0) return 'in the future';
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return 'just now';
  if (diffMs < hour) {
    const m = Math.round(diffMs / minute);
    return `${m} min${m === 1 ? '' : 's'} ago`;
  }
  if (diffMs < day) {
    const h = Math.round(diffMs / hour);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.round(diffMs / day);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/**
 * Show the user a picker of providers — disabled rows for the
 * "coming soon" entries so they see the roadmap. Returns the chosen
 * provider, or `null` if the user cancels.
 */
async function pickProvider(): Promise<CloudProvider | null> {
  // Skip the picker when there's only one available provider — saves
  // the user a tap they don't need today.
  const ready = PROVIDERS.filter((prov) => prov.available);
  if (ready.length === 1) return ready[0];

  const selection = await p.select<string>({
    message: 'Where do you want to deploy?',
    options: PROVIDERS.map((prov) => ({
      value: prov.id,
      label: prov.available ? prov.displayName : `${prov.displayName} ${pc.dim('(coming soon)')}`,
      hint: prov.tagline,
    })),
  });
  if (p.isCancel(selection) || typeof selection !== 'string') return null;
  const found = PROVIDERS.find((prov) => prov.id === selection);
  if (!found || !found.available) {
    p.note(
      `${found?.displayName ?? 'That provider'} isn’t implemented yet — we'll ping you on Twitter/X when it ships.`,
      'Heads up',
    );
    return null;
  }
  return found;
}
