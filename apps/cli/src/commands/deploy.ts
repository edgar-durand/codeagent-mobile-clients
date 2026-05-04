import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { PROVIDERS } from '../services/providers';
import type { CloudProvider, DeployableProject, ExistingWorkspace, Workspace } from '../services/providers';

const execFileP = promisify(execFile);

/**
 * `codeam deploy` — provision a fresh cloud workspace, install the
 * Claude CLI inside it, copy the user's local Claude config so they
 * don't have to re-auth, and finish by streaming `codeam pair` from
 * the workspace so the user gets a live pairing code on their local
 * terminal that's already connected to the remote codespace.
 *
 * The orchestrator is provider-agnostic — it only talks through the
 * `CloudProvider` interface — so adding new backends (Gitpod, Coder,
 * etc.) is one new file in `services/providers/`.
 */
export async function deploy(): Promise<void> {
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

  // Step 4 — Decide credential strategy. We could silently bridge
  // the user's local Claude credentials to the workspace, but that
  // assumes they want to use the SAME account on the cloud agent —
  // and plenty of users explicitly want a different one (work vs.
  // personal Claude account, a sandbox account for the deploy, etc.).
  //
  // So: only ask if there's something we COULD bridge. If yes,
  // confirm with the user (default: yes, since that's the common
  // "skip re-auth" pitch). If they say no, we skip the bridge and
  // the verify step in step 7 will route them through interactive
  // `claude login` automatically with whatever account they want.
  const localClaudeDir = path.join(os.homedir(), '.claude');
  const localCredsKind = await detectLocalClaudeCredentials(localClaudeDir);
  let bridged: 'flat-file' | 'macos-keychain' | 'none' = 'none';

  if (localCredsKind !== 'none') {
    const sourceLabel =
      localCredsKind === 'flat-file' ? '~/.claude/.credentials.json'
      : 'macOS Keychain';
    const useLocal = await p.confirm({
      message: `Copy your local Claude credentials (${sourceLabel}) to the workspace?`,
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
      // claude's install.sh launches `claude` once during setup, and
      // that first invocation persists "first-launch" state files
      // that can ignore credentials written afterward. Writing creds
      // first means claude's first run already sees a logged-in user
      // and skips the first-launch UX entirely.
      const credStep = p.spinner();
      credStep.start('Bridging Claude credentials…');
      bridged = await bridgeClaudeCredentials(provider, workspace.id, localClaudeDir);
      switch (bridged) {
        case 'flat-file':
          credStep.stop('✓ Local credentials staged');
          break;
        case 'macos-keychain':
          credStep.stop('✓ Credentials extracted from macOS Keychain and staged');
          break;
        case 'none':
          credStep.stop('⚠ Could not extract local credentials — falling back to remote login');
          break;
      }
    }
  }

  // Step 5 — Install Claude CLI on the workspace.
  const claudeStep = p.spinner();
  claudeStep.start('Installing Claude CLI on workspace…');
  const installResult = await provider.exec(
    workspace.id,
    'curl -fsSL https://claude.ai/install.sh | bash',
  );
  if (installResult.code !== 0) {
    claudeStep.stop('✗ Claude CLI install failed');
    p.cancel(installResult.stderr.slice(0, 1000));
    process.exit(1);
  }
  claudeStep.stop('✓ Claude CLI installed');

  // Step 6 — Copy local config (skills/settings/subagents/plugins).
  // This goes AFTER install so it overlays the user's customisations
  // on top of install's defaults. Excludes drop the heavy local-only
  // state (~700MB of conversation history etc.) that the remote
  // never reads.
  const haveLocalClaude =
    fs.existsSync(localClaudeDir) && fs.statSync(localClaudeDir).isDirectory();
  if (haveLocalClaude) {
    const copyStep = p.spinner();
    copyStep.start('Copying local Claude config to workspace…');
    try {
      await provider.uploadDirectory(
        workspace.id,
        localClaudeDir,
        '/home/codespace/.claude',
        {
          exclude: [
            './projects',          // per-project conversation history (often 700MB+)
            './file-history',      // per-project file diffs
            './downloads',         // downloaded artifacts
            './image-cache',       // cached images
            './paste-cache',       // clipboard/paste cache
            './backups',           // local backups
            './shell-snapshots',   // shell history snapshots
            './telemetry',         // analytics dumps
            './statsig',           // feature-flag cache
            './cache',             // generic cache dir
            './history.jsonl',     // global REPL history
            './ide',               // local IDE bridge state
            './todos',             // local todo state
            './tasks',             // local task state
            // Don't overwrite the credentials we already staged in
            // step 4 — the local dir on macOS doesn't have a flat
            // credentials file anyway, but on Linux it would, and a
            // re-write here would be redundant.
            './.credentials.json',
          ],
        },
      );
      copyStep.stop('✓ Claude config uploaded');
    } catch (err) {
      copyStep.stop('⚠ Could not upload Claude config (continuing)');
      void err;
    }
  }

  // Step 6.5 — Ship `~/.claude.json` (the sibling FILE, not the dir
  // tarred above). This file holds the user's UI state across
  // launches: `hasCompletedOnboarding`, `hasIdeOnboardingBeenShown`,
  // `lastOnboardingVersion`, `tipsHistory`, etc. Without it, claude
  // treats the codespace as a brand-new install and shows the
  // "Select login method" + onboarding flow on every interactive
  // launch even when credentials are already valid.
  //
  // Only ships when the user opted into the credential bridge — the
  // file contains `oauthAccount` (email, orgId) so it'd be a privacy
  // leak to ship when they're going to log in as a different account.
  if (bridged !== 'none') {
    const localClaudeJson = path.join(os.homedir(), '.claude.json');
    if (fs.existsSync(localClaudeJson)) {
      try {
        const contents = fs.readFileSync(localClaudeJson);
        await provider.uploadFile(
          workspace.id,
          '/home/codespace/.claude.json',
          contents,
          { mode: 0o600 },
        );
      } catch (err) {
        // Best-effort: claude still works without this file, the
        // user just sees the onboarding screen.
        void err;
      }
    }
  }

  // Step 7 — Verify Claude auth on the workspace, and fall back to
  // interactive login if anything is wrong. We don't trust "we wrote
  // a file" as success — credentials might be expired, the format
  // might have changed in a Claude release, the keychain might've
  // been empty, etc. The user sees ONE outcome: a logged-in Claude.
  // They never have to know how it got there.
  const verifyStep = p.spinner();
  verifyStep.start('Verifying Claude auth on workspace…');
  const verified = await verifyClaudeAuth(provider, workspace.id);
  if (verified) {
    verifyStep.stop('✓ Claude is logged in — no re-auth needed');
  } else {
    verifyStep.stop('· Claude not yet authenticated — running login flow');
    await runRemoteClaudeLogin(provider, workspace.id);
    // After interactive login, verify one more time so we catch the
    // case where the user bailed out mid-flow.
    const reverified = await verifyClaudeAuth(provider, workspace.id);
    if (!reverified) {
      p.note(
        'Claude auth could not be confirmed. You may need to run `claude /login` manually inside the codespace.',
        'Heads up',
      );
    }
  }

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

  // Step 7 — Pair the workspace, but in a way that *survives* the
  // local SSH disconnect. `codeam pair` falls through into the
  // long-running mobile↔Claude relay (`start()`) once the user pairs
  // — if we just stream it normally, the local terminal stays bound
  // forever, and a Ctrl+C kills the relay along with the SSH session,
  // dropping the mobile app's connection.
  //
  // The wrapper:
  //   1. `nohup`s `codeam pair` with stdin from /dev/null so it
  //      ignores SIGHUP (SSH disconnect) AND so a local Ctrl+C
  //      doesn't reach it (`disown` removes it from the shell's job
  //      table so signal-on-shell-exit doesn't propagate either).
  //   2. Tees stdout/stderr into a session log on the codespace and
  //      `tail -F`s it locally, so the QR / pairing-code renders to
  //      the user's terminal in real time.
  //   3. Waits for the "Paired with" marker. On success, the local
  //      wrapper exits cleanly and SSH disconnects — the relay keeps
  //      running because it's nohup'd + disowned.
  //   4. On Ctrl+C: kills the tail and exits, BUT does NOT touch the
  //      remote relay. Local terminal returns; remote pair-or-relay
  //      keeps running. (If the user cancels before pairing, codeam
  //      pair has its own 5-min timeout, after which it'll exit on
  //      its own — no orphans.)
  p.note(
    [
      `Workspace: ${pc.cyan(workspace.displayName ?? workspace.id)}`,
      workspace.webUrl ? `Web:       ${pc.cyan(workspace.webUrl)}` : '',
      '',
      'Starting `codeam pair` on the workspace.',
      'Scan the QR code below with the CodeAgent Mobile app to finish pairing.',
      pc.dim('(Once paired, this terminal disconnects automatically; the session stays alive on the codespace.)'),
    ]
      .filter(Boolean)
      .join('\n'),
    'Almost there',
  );

  // After Claude is set up, run `codeam pair` on the workspace via
  // PM2 — a battle-tested Node.js process manager whose god-daemon
  // survives SSH session cleanup on Codespaces (where nohup, setsid
  // and tmux all fail). PM2 owns the lifecycle: spawn, restart on
  // crash, log redirection, graceful stop.
  //
  // The wrapper:
  //   1. Installs PM2 if missing (idempotent first-run setup).
  //   2. `pm2 start codeam --name codeam-pair -- pair` with merged
  //      stdout/stderr piped to a session log.
  //   3. Tails the log locally so the QR / pairing code renders.
  //   4. Phase 1: wait for "Paired with"; phase 2: wait for
  //      "for shortcuts" so any first-time Claude prompts (trust
  //      this folder, model picker, etc.) get answered on the
  //      phone before we close locally.
  //   5. Local Ctrl+C kills only the local tail — PM2 keeps the
  //      relay running.
  const wrapper = [
    'mkdir -p ~/.codeam-deploy',
    'LOG=~/.codeam-deploy/session.log',
    ': > "$LOG"',
    // The default `gh codespace ssh` cwd is the repo root
    // (/workspaces/<repo>), which is exactly where Claude needs to
    // run so it can read/edit project files. Pass that to PM2 via
    // --cwd so the relay's child Claude inherits the right
    // working directory.
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
    // can't start (e.g. backend unreachable) — three attempts is
    // enough for transient flakes, anything more wastes time.
    // No `--time` (would prefix every line with a timestamp and
    // break the QR rendering); no `--no-pmx` either (default off).
    'pm2 start codeam --name codeam-pair --cwd "$PROJECT_DIR" --max-restarts 3 -o "$LOG" -e "$LOG" --merge-logs -- pair >/dev/null 2>&1',
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
 * Run `claude login` inside the workspace with full stdio inheritance
 * so the URL the CLI prints (and any code-paste prompt the auth flow
 * asks for) come straight to the user's local terminal. After the
 * login finishes we sanity-check with `claude` to confirm the
 * credentials landed; if it looks broken we surface a friendly note
 * but continue — pairing still works for non-Claude agents.
 *
 * The remote command shape is:
 *   bash -lc "claude login"
 * via the provider's `streamCommand` so PATH from .bashrc / .zshrc /
 * /etc/profile.d / nvm pick up the freshly-installed `claude` binary.
 */
async function runRemoteClaudeLogin(
  provider: CloudProvider,
  workspaceId: string,
): Promise<void> {
  p.note(
    [
      'A login URL will print below. Open it in your local browser, sign in,',
      'and paste any code Claude asks for back into this terminal.',
    ].join('\n'),
    'Authenticating Claude on workspace',
  );
  const result = await provider.streamCommand(
    workspaceId,
    'bash -lc "claude login || claude /login || true"',
  );
  if (result.code !== 0) {
    p.note(
      'claude login exited non-zero. You can re-run it manually inside the codespace later.',
      'Heads up',
    );
  }
}

/**
 * Detect whether the user has Claude credentials we could ship to a
 * remote workspace, WITHOUT actually extracting them. Used to decide
 * whether to ask "want to copy your local creds?" — there's no point
 * showing the prompt if there are no creds to copy.
 *
 *   - Linux  → `~/.claude/.credentials.json` exists?
 *   - macOS  → Keychain has a `Claude Code-credentials` entry? We
 *              probe with the metadata-only form of `security`
 *              (`find-generic-password` without `-w`) so the user
 *              isn't prompted to unlock the keychain just to be
 *              asked the question.
 *   - Windows → Not yet implemented; reports `none`.
 */
async function detectLocalClaudeCredentials(
  localClaudeDir: string,
): Promise<'flat-file' | 'macos-keychain' | 'none'> {
  if (fs.existsSync(path.join(localClaudeDir, '.credentials.json'))) {
    return 'flat-file';
  }
  if (process.platform === 'darwin') {
    try {
      // `security find-generic-password -s <service>` (no -w) returns
      // metadata if the entry exists, errors if not. Doesn't expose
      // the secret, doesn't trigger a keychain unlock prompt.
      await execFileP(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials'],
        { maxBuffer: 1024 * 1024 },
      );
      return 'macos-keychain';
    } catch {
      return 'none';
    }
  }
  return 'none';
}

/**
 * Verify that `claude` is authenticated on the workspace by running
 * `claude auth status --json` and inspecting the JSON output for
 * `loggedIn: true`. We deliberately call `auth status` rather than
 * trying to parse the credentials file ourselves — Claude is the
 * source of truth for whether tokens are valid (it knows about
 * expiry, scope mismatches, format changes between versions, etc.).
 *
 * Used at two points by `codeam deploy`:
 *   1. After the credential bridge, to decide whether we can skip
 *      interactive login.
 *   2. After interactive login, to confirm the user actually finished
 *      the device-code flow (not bail out mid-flow with a half-done
 *      auth state).
 *
 * Returns `true` only when Claude reports `loggedIn: true`. Any
 * non-zero exit, malformed JSON, missing field, or `loggedIn: false`
 * counts as not-authed.
 */
async function verifyClaudeAuth(
  provider: CloudProvider,
  workspaceId: string,
): Promise<boolean> {
  // Run via login shell so the freshly-installed `claude` binary is
  // on PATH (it lives in ~/.local/bin which is added by .bashrc).
  const result = await provider.exec(
    workspaceId,
    'bash -lc "claude auth status 2>/dev/null || true"',
  );
  if (result.code !== 0) return false;
  // Find the first balanced JSON object in stdout — `claude auth
  // status` may print warnings before the JSON on some platforms.
  const jsonStart = result.stdout.indexOf('{');
  if (jsonStart < 0) return false;
  try {
    const parsed = JSON.parse(result.stdout.slice(jsonStart)) as { loggedIn?: boolean };
    return parsed.loggedIn === true;
  } catch {
    return false;
  }
}

/**
 * Cross-platform credential bridge for Claude Code on the codespace.
 *
 *   - Linux  → credentials live at `~/.claude/.credentials.json` as
 *              a flat file. The tar in `uploadDirectory` already
 *              shipped it; nothing to do here. (Returns `'flat-file'`.)
 *   - macOS  → credentials live in the macOS Keychain under the
 *              service name `Claude Code-credentials`. We pull the
 *              JSON via `security find-generic-password -w` and write
 *              it to `~/.claude/.credentials.json` on the remote
 *              (chmod 600). Same shape Claude Code reads on Linux.
 *   - Windows → credentials live in Windows Credential Manager. We
 *              don't auto-bridge today (would need a PowerShell or
 *              native API hop); the caller falls back to interactive
 *              login. (Returns `'none'`.)
 *
 * Returns a discriminator the caller uses to decide whether to
 * announce success or run the remote-login fallback.
 */
async function bridgeClaudeCredentials(
  provider: CloudProvider,
  workspaceId: string,
  localClaudeDir: string,
): Promise<'flat-file' | 'macos-keychain' | 'none'> {
  // Case 1 — flat file (Linux's default; also possible on macOS for
  // users on a custom build). The directory tar already shipped it.
  const fileBased = path.join(localClaudeDir, '.credentials.json');
  if (fs.existsSync(fileBased)) return 'flat-file';

  // Case 2 — macOS Keychain. Out of process: shell to `security`,
  // pipe the JSON straight into the remote write so it never touches
  // disk on either side.
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileP(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { maxBuffer: 1024 * 1024 },
      );
      const json = stdout.trim();
      if (json.length === 0) return 'none';
      await provider.uploadFile(
        workspaceId,
        '/home/codespace/.claude/.credentials.json',
        json,
        { mode: 0o600 },
      );
      return 'macos-keychain';
    } catch {
      // No entry, denied, or `security` missing — fall through.
      return 'none';
    }
  }

  // Case 3 — Windows Credential Manager (or Linux installs that use
  // libsecret instead of the flat file). Bridging from these stores
  // requires native API hops we haven't built yet; the caller will
  // run `claude login` interactively on the remote instead.
  return 'none';
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
