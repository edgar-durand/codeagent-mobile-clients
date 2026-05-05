import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import pc from 'picocolors';
import { getActiveSession, ensurePluginId } from '../config';
import { showIntro, showInfo } from '../ui/banner';
import { WebSocketService } from '../services/websocket.service';
import { CommandRelayService } from '../services/command-relay.service';
import { ClaudeService } from '../services/claude.service';
import { findInPath } from '../services/pty/types';
import { OutputService } from '../services/output.service';
import { HistoryService } from '../services/history.service';
import { parsePayload, startCommandSchema, type FileEntry } from '../lib/payload';
import { readProjectFile, writeProjectFile } from '../services/file-ops.service';
import {
  listProjectFiles,
  gitStatus,
  gitDiff,
  gitDiffStaged,
  gitLog,
  gitCommit,
  gitPush,
  gitPull,
  gitResolve,
} from '../services/project-ops.service';

// FileAttachment shape mirrors packages/shared/src/types/agent.ts — kept in
// sync via the zod schema in src/lib/payload.ts (see `fileEntrySchema`).
type FileAttachment = FileEntry;

/** Write base64-encoded file attachments to temp files; returns their paths. */
function saveFilesTemp(files: FileAttachment[]): string[] {
  return files
    .filter(({ base64 }) => base64 && base64.length > 0)
    .map(({ filename, base64 }) => {
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      const tmpPath = path.join(os.tmpdir(), `codeam-${randomUUID()}-${safeName}`);
      fs.writeFileSync(tmpPath, Buffer.from(base64, 'base64'));
      return tmpPath;
    });
}

export async function start(): Promise<void> {
  showIntro();

  const session = getActiveSession();
  if (!session) {
    console.log(`  ${pc.dim('No paired session found.')}`);
    console.log(`  ${pc.dim(`Run ${pc.white('codeam pair')} to connect your mobile app.`)}\n`);
    process.exit(0);
  }

  // Use the per-session pluginId (set since v1.4.6); fall back to the global
  // installation-level pluginId for sessions paired with older CLI versions.
  const pluginId = session.pluginId ?? ensurePluginId();

  showInfo(`${session.userName}  ·  ${pc.cyan(session.plan)}`);
  showInfo('Launching Claude Code...\n');

  const cwd = process.cwd();

  const ws = new WebSocketService(session.id, pluginId);
  const historySvc = new HistoryService(pluginId, cwd);
  // Quota fetch: spawn a separate background claude process to get /usage info
  let quotaFetchInProgress = false;

  function fetchQuotaUsage(): void {
    if (quotaFetchInProgress) return;
    quotaFetchInProgress = true;

    const claudeCmd = findInPath('claude') ? 'claude' : 'claude-code';
    if (!claudeCmd) { quotaFetchInProgress = false; return; }

    const helperScript = `import os,pty,sys,select,signal,struct,fcntl,termios,errno
m,s=pty.openpty()
try:
    fcntl.ioctl(s,termios.TIOCSWINSZ,struct.pack('HHHH',30,120,0,0))
except Exception:pass
pid=os.fork()
if pid==0:
    os.close(m);os.setsid()
    try:fcntl.ioctl(s,termios.TIOCSCTTY,0)
    except Exception:pass
    for fd in[0,1,2]:os.dup2(s,fd)
    if s>2:os.close(s)
    os.execvp(sys.argv[1],sys.argv[1:])
    sys.exit(127)
os.close(s)
done=[False]
def onchld(n,f):
    try:os.waitpid(pid,os.WNOHANG)
    except Exception:pass
    done[0]=True
signal.signal(signal.SIGCHLD,onchld)
i=sys.stdin.fileno();o=sys.stdout.fileno()
while not done[0]:
    try:r,_,_=select.select([i,m],[],[],0.1)
    except OSError as e:
        if e.errno==errno.EINTR:continue
        break
    if i in r:
        try:
            d=os.read(i,4096)
            if d:os.write(m,d)
            else:break
        except OSError:break
    if m in r:
        try:
            d=os.read(m,4096)
            if d:os.write(o,d)
        except OSError:done[0]=True
try:os.kill(pid,signal.SIGTERM)
except Exception:pass
try:
    _,st=os.waitpid(pid,0)
    sys.exit((st>>8)&0xFF)
except Exception:sys.exit(0)
`;
    const helperPath = path.join(os.tmpdir(), 'codeam-quota-helper.py');
    fs.writeFileSync(helperPath, helperScript, { mode: 0o644 });

    const python = findInPath('python3') ?? findInPath('python');
    if (!python) { quotaFetchInProgress = false; return; }

    const proc = spawn(python, [helperPath, claudeCmd, '--tools', ''], {
      stdio: ['pipe', 'pipe', 'ignore'],
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'dumb', COLUMNS: '120', LINES: '30' },
    });

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });

    // Wait for Claude to start (longer without --bare: OAuth + hooks),
    // send /usage, then parse and kill
    setTimeout(() => {
      proc.stdin?.write('/usage\r');
      setTimeout(() => {
        const clean = output.replace(/\x1B\[[^@-~]*[@-~]/g, '').replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ');
        const weekMatch = clean.match(/(\d+)%\s*used/i) || clean.match(/(\d+)\s*%/);
        if (weekMatch) {
          historySvc.setQuotaPercent(parseInt(weekMatch[1], 10));
        }
        const resetMatch = clean.match(/resets\s+(.+?)(?:\s*\(|$)/im);
        if (resetMatch) {
          historySvc.setRateLimitReset(resetMatch[1].trim());
        }
        try { proc.kill(); } catch {}
        try { fs.unlinkSync(helperPath); } catch {}
        quotaFetchInProgress = false;
      }, 5000);
    }, 8000);

    proc.on('exit', () => { quotaFetchInProgress = false; });
    // Safety timeout: kill after 20s
    setTimeout(() => { try { proc.kill(); } catch {} }, 20000);
  }

  const outputSvc = new OutputService(session.id, pluginId, (conversationId) => {
    historySvc.setCurrentConversationId(conversationId);
  }, (reset) => {
    historySvc.setRateLimitReset(reset);
  }, () => {
    // Fetch /usage when cache is stale (30 min TTL)
    if (historySvc.isQuotaStale()) {
      fetchQuotaUsage();
    }
  }, () => {
    // Terminal-initiated turn: user typed directly in the terminal.
    // Poll the JSONL until Claude Code writes the new user message, then
    // start the turn with: clear → user_message → new_turn → response.
    const prevCount = historySvc.getCurrentMessageCount();
    historySvc.waitForNewUserMessage(prevCount)
      .then((userText) => outputSvc.startTerminalTurn(userText ?? undefined))
      .catch(() => outputSvc.startTerminalTurn(undefined));
  }, session.pluginAuthToken);

  /** Dispatch a prompt to Claude and signal the mobile app that a new turn started. */
  function sendPrompt(prompt: string): void {
    outputSvc.newTurn();
    claude.sendCommand(prompt);
  }

  const relay = new CommandRelayService(pluginId, async (cmd) => {
    // Validate the incoming payload once at the top — every handler reads
    // off the parsed/narrowed object instead of casting per field. If the
    // backend sends a wrong shape we drop the command rather than crash mid-flight.
    const parsed = parsePayload(startCommandSchema, cmd.payload);
    if (!parsed) {
      showInfo(`Ignoring malformed ${cmd.type} payload.`);
      return;
    }
    switch (cmd.type) {
      case 'start_task': {
        const { prompt, files } = parsed;
        const effectivePrompt = prompt ?? '';
        if (files && files.length > 0) {
          const paths = saveFilesTemp(files);
          const atRefs = paths.map((p) => `@${p}`).join(' ');
          outputSvc.newTurn();
          claude.sendCommand(`${atRefs} ${effectivePrompt}`.trim());
          setTimeout(() => {
            for (const p of paths) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
          }, 120_000);
        } else if (effectivePrompt) {
          sendPrompt(effectivePrompt);
        }
        break;
      }
      case 'provide_input': {
        const { input } = parsed;
        if (input) sendPrompt(input);
        break;
      }
      case 'select_option': {
        // Navigate React Ink's selector to the target option and confirm.
        // Must use claude.selectOption() (not sendPrompt/sendCommand) so that
        // arrows and Enter are sent separately with a delay — otherwise React's
        // stale closure captures index=0 for the Enter key and always picks option 1.
        // `from` is the current highlighted position sent by the client for
        // list-style selectors; defaults to 0 (numbered selectors always start there).
        const index = parsed.index ?? 0;
        const from  = parsed.from  ?? 0;
        outputSvc.newTurn();
        claude.selectOption(index, from);
        break;
      }
      case 'escape_key':
        outputSvc.newTurn();
        claude.sendEscape();
        break;
      case 'stop_task':
        claude.interrupt();
        break;
      case 'set_keep_alive': {
        // Mobile/web's "Avoid suspend codespace on inactivity"
        // toggle. The heartbeat only runs inside a GitHub Codespace
        // (CODESPACES=true env var) — on a local pairing there's no
        // inactivity timer to keep alive, so the toggle is a no-op
        // and we tell the backend so the apps can warn / hide it.
        const enabled = !!cmd.payload.enabled;
        const inCodespaceEnv = process.env.CODESPACES === 'true';
        setKeepAlive(enabled);
        try {
          await relay.sendResult(
            cmd.id,
            'success',
            { enabled, applied: enabled && inCodespaceEnv, runtime: inCodespaceEnv ? 'github-codespaces' : 'local' },
          );
        } catch { /* ignore */ }
        break;
      }
      case 'shutdown_session': {
        // Mobile/web sent "Stop session". Two layers of cleanup:
        //   1. Tear down PM2's supervisor + kill Claude + exit so
        //      our agent stops responding.
        //   2. If we're INSIDE a Codespace, also run
        //      `gh codespace stop` so the workspace itself
        //      suspends — saves the user's compute hours
        //      immediately instead of waiting for GitHub's idle
        //      timeout. Detached + fire-and-forget so it survives
        //      our exit and the SSH tear-down.
        try { await relay.sendResult(cmd.id, 'success', { ok: true }); } catch { /* best-effort */ }
        try { claude.kill(); } catch { /* best-effort */ }
        const codespaceName = process.env.CODESPACE_NAME;
        if (codespaceName && process.env.CODESPACES === 'true') {
          try {
            const stopProc = spawn(
              'bash',
              ['-lc', `sleep 1; gh codespace stop -c ${JSON.stringify(codespaceName)} >/dev/null 2>&1 || true`],
              { detached: true, stdio: 'ignore' },
            );
            stopProc.unref();
          } catch { /* gh may be unavailable; ignore */ }
        }
        try {
          const proc = spawn('bash', ['-lc', 'pm2 delete codeam-pair >/dev/null 2>&1 || true'], {
            detached: true,
            stdio: 'ignore',
          });
          proc.unref();
        } catch { /* pm2 may not be installed locally; ignore */ }
        outputSvc.dispose();
        relay.stop();
        ws.disconnect();
        process.exit(0);
      }
      case 'get_context': {
        const usage = historySvc.getCurrentUsage();
        const monthlyCost = historySvc.getMonthlyEstimatedCost();
        const rateLimitReset = historySvc.getRateLimitReset();
        const quotaPercent = historySvc.getQuotaPercent();
        const base = usage
          ? { ...usage, monthlyCost }
          : { used: 0, total: 200000, percent: 0, model: null, outputTokens: 0, cacheReadTokens: 0, monthlyCost, error: 'No usage data found' };
        const result = { ...base, ...(rateLimitReset ? { rateLimitReset } : {}), ...(quotaPercent !== null ? { quotaPercent } : {}) };
        await relay.sendResult(cmd.id, 'completed', result as Record<string, unknown>);
        break;
      }
      case 'resume_session': {
        const { id, auto } = parsed;
        if (!id) break;
        historySvc.setCurrentConversationId(id);
        await historySvc.loadConversation(id);
        await outputSvc.newTurnResume(id);
        claude.restart(id, auto ?? false);
        break;
      }
      case 'get_conversation': {
        const currentId = historySvc.getCurrentConversationId();
        if (currentId) {
          try {
            await historySvc.loadConversation(currentId);
            await relay.sendResult(cmd.id, 'completed', { conversationId: currentId });
          } catch {
            await relay.sendResult(cmd.id, 'failed', {});
          }
        } else {
          await relay.sendResult(cmd.id, 'completed', { conversationId: null });
        }
        break;
      }
      case 'list_models': {
        // Claude Code models available via `/model` slash command. These
        // match the ids Claude accepts so the mobile picker can switch
        // models by sending `/model <id>` as a prompt.
        const models = [
          { id: 'claude-opus-4-7',           label: 'Claude Opus 4.7',   description: 'Most capable',  family: 'claude',  vendor: 'anthropic', isDefault: false },
          { id: 'claude-opus-4-6',           label: 'Claude Opus 4.6',   description: 'Top tier',      family: 'claude',  vendor: 'anthropic', isDefault: false },
          { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6', description: 'Balanced',      family: 'claude',  vendor: 'anthropic', isDefault: true  },
          { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5',  description: 'Fastest',       family: 'claude',  vendor: 'anthropic', isDefault: false },
        ];
        await relay.sendResult(cmd.id, 'completed', { models });
        break;
      }
      case 'read_file': {
        const { path: filePath } = parsed;
        if (!filePath) {
          await relay.sendResult(cmd.id, 'failed', { error: 'Missing path' });
          break;
        }
        const result = await readProjectFile(filePath);
        await relay.sendResult(cmd.id, 'completed', result as Record<string, unknown>);
        break;
      }
      case 'write_file': {
        const { path: filePath, content } = parsed;
        if (!filePath || typeof content !== 'string') {
          await relay.sendResult(cmd.id, 'failed', { error: 'Missing path or content' });
          break;
        }
        const result = await writeProjectFile(filePath, content);
        await relay.sendResult(cmd.id, 'completed', result as Record<string, unknown>);
        break;
      }
      case 'list_files': {
        const result = await listProjectFiles({ query: parsed.query });
        await relay.sendResult(cmd.id, 'completed', result as unknown as Record<string, unknown>);
        break;
      }
      case 'git_status': {
        const result = await gitStatus();
        await relay.sendResult(cmd.id, 'completed', result as unknown as Record<string, unknown>);
        break;
      }
      case 'git_diff': {
        const { path: filePath } = parsed;
        const result = await gitDiff(filePath ?? null);
        await relay.sendResult(cmd.id, 'completed', result as Record<string, unknown>);
        break;
      }
      case 'git_diff_staged': {
        const { path: filePath } = parsed;
        const result = await gitDiffStaged(filePath ?? null);
        await relay.sendResult(cmd.id, 'completed', result as Record<string, unknown>);
        break;
      }
      case 'git_log': {
        const result = await gitLog(parsed.limit ?? 30);
        await relay.sendResult(cmd.id, 'completed', result as unknown as Record<string, unknown>);
        break;
      }
      case 'git_commit': {
        if (!parsed.message) {
          await relay.sendResult(cmd.id, 'failed', { error: 'Missing message' });
          break;
        }
        const result = await gitCommit(parsed.message, parsed.paths);
        await relay.sendResult(cmd.id, 'completed', result as Record<string, unknown>);
        break;
      }
      case 'git_push': {
        const result = await gitPush();
        await relay.sendResult(cmd.id, 'completed', result as Record<string, unknown>);
        break;
      }
      case 'git_pull': {
        const result = await gitPull();
        await relay.sendResult(cmd.id, 'completed', result as Record<string, unknown>);
        break;
      }
      case 'git_resolve': {
        const { path: filePath, side } = parsed;
        if (!filePath || !side) {
          await relay.sendResult(cmd.id, 'failed', { error: 'Missing path or side' });
          break;
        }
        const result = await gitResolve(filePath, side);
        await relay.sendResult(cmd.id, 'completed', result as Record<string, unknown>);
        break;
      }
    }
  });

  ws.addHandler({
    onConnected() { /* silent */ },
    onDisconnected() { /* reconnect handled internally */ },
    onMessage(type, payload) {
      if (type !== 'agent_command') return;
      const cmdType = typeof payload.type === 'string' ? payload.type : null;
      if (!cmdType) return;
      const parsed = parsePayload(startCommandSchema, payload.payload ?? {});
      if (!parsed) {
        showInfo(`Ignoring malformed ${cmdType} payload (ws).`);
        return;
      }
      if (cmdType === 'start_task') {
        const { prompt, files } = parsed;
        const effectivePrompt = prompt ?? '';
        if (files && files.length > 0) {
          const paths = saveFilesTemp(files);
          const atRefs = paths.map((p) => `@${p}`).join(' ');
          outputSvc.newTurn();
          claude.sendCommand(`${atRefs} ${effectivePrompt}`.trim());
          setTimeout(() => {
            for (const p of paths) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
          }, 120_000);
        } else if (effectivePrompt) {
          sendPrompt(effectivePrompt);
        }
      } else if (cmdType === 'provide_input') {
        const { input } = parsed;
        if (input) sendPrompt(input);
      } else if (cmdType === 'select_option') {
        const index = parsed.index ?? 0;
        const from  = parsed.from  ?? 0;
        outputSvc.newTurn();
        claude.selectOption(index, from);
      } else if (cmdType === 'escape_key') {
        outputSvc.newTurn();
        claude.sendEscape();
      } else if (cmdType === 'stop_task') {
        claude.interrupt();
      } else if (cmdType === 'get_conversation') {
        const currentId = historySvc.getCurrentConversationId();
        if (currentId) {
          historySvc.loadConversation(currentId).catch(() => {});
        }
      } else if (cmdType === 'resume_session') {
        const { id, auto } = parsed;
        if (id) {
          const autoFlag = auto ?? false;
          historySvc.loadConversation(id)
            .then(() => outputSvc.newTurnResume(id))
            .then(() => { claude.restart(id, autoFlag); })
            .catch(() => {});
        }
      }
    },
  });

  ws.connect();
  relay.start();

  const claude = new ClaudeService({
    cwd: process.cwd(),
    onData(raw) { outputSvc.push(raw); },
    onExit(code) {
      process.removeListener('SIGINT', sigintHandler);
      outputSvc.dispose();
      relay.stop();
      ws.disconnect();
      process.exit(code);
    },
  });

  function sigintHandler() {
    claude.kill();
    outputSvc.dispose();
    relay.stop();
    ws.disconnect();
    process.exit(0);
  }

  process.once('SIGINT', sigintHandler);
  await claude.spawn();
  setTimeout(() => {
    historySvc.detectCurrentConversation();
    historySvc.load().catch(() => {});
    // Also push the current conversation's messages so the app can auto-load
    // the terminal context when a session is opened.
    const currentId = historySvc.getCurrentConversationId();
    if (currentId) {
      historySvc.loadConversation(currentId).catch(() => {});
    }
  }, 2000);
  // Fetch quota usage on startup (after Claude is ready)
  setTimeout(() => { fetchQuotaUsage(); }, 5000);

  /**
   * Honor the "Avoid suspend codespace on inactivity" toggle from
   * the apps' Settings modal. Only meaningful when this agent is
   * actually running inside a GitHub Codespace.
   *
   * Why the previous "ping the API" approach didn't work: GitHub's
   * inactivity detection is based on INCOMING connections (VS Code
   * Remote, `gh codespace ssh`), not on outgoing API calls from the
   * VM itself. So `gh codespace list` from inside the codespace
   * doesn't reset the idle timer — and the workspace got suspended
   * anyway after 30 min of "real" inactivity.
   *
   * What actually works: bump the codespace's `idle_timeout_minutes`
   * via the GitHub API. Default is 30; max is 240 (or higher if the
   * org admin raised it). We set 240 when the toggle is on and reset
   * to 30 when it's off. We re-apply the setting periodically because
   * GitHub does NOT reset the idle clock on PATCH — it just sets the
   * ceiling, so re-PATCHing has no extra effect, but doing it on a
   * timer protects against transient API failures + clock skew.
   *
   * Beyond 240 min of true inactivity (no SSH / no VS Code), the
   * codespace WILL stop regardless of what we do — GitHub's design.
   * The toggle gives the user 8× longer than default; not infinite.
   */
  const inCodespace = process.env.CODESPACES === 'true';
  const codespaceName = process.env.CODESPACE_NAME;
  let keepAliveTimer: NodeJS.Timeout | null = null;
  async function setIdleTimeout(minutes: number): Promise<void> {
    if (!inCodespace || !codespaceName) return;
    // PATCH /user/codespaces/<name> { idle_timeout_minutes }.
    // gh's --field flag is the cleanest way to send a numeric body
    // without shell-escaping JSON ourselves.
    await new Promise<void>((resolve) => {
      const proc = spawn(
        'gh',
        [
          'api',
          '-X', 'PATCH',
          `/user/codespaces/${codespaceName}`,
          '-F', `idle_timeout_minutes=${minutes}`,
        ],
        { stdio: 'ignore', detached: true },
      );
      proc.unref();
      proc.on('exit', () => resolve());
      proc.on('error', () => resolve());
    });
  }
  function setKeepAlive(enabled: boolean): void {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    if (!inCodespace || !codespaceName) return;
    if (!enabled) {
      // Reset to GitHub's default idle timeout.
      void setIdleTimeout(30);
      return;
    }
    // Set to the max (240 min) immediately + every 30 min just in
    // case the first call hit a transient API hiccup.
    void setIdleTimeout(240);
    keepAliveTimer = setInterval(() => { void setIdleTimeout(240); }, 30 * 60 * 1000);
  }
}
