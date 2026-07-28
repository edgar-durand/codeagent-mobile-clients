/**
 * Claude credential-sync watcher — keep the VAULT current from a live session.
 *
 * Claude Code rotates its OAuth token on use (Anthropic single-use refresh
 * tokens), so a credential vaulted at link time goes stale — a LATER deploy then
 * injects a dead token ("Claude creds expired on a new deploy" while an existing
 * session still works). This watches the user's local `~/.claude/.credentials.json`
 * on an active paired session and pushes the fresh blob to the vault whenever the
 * agent rotates it. It also fires ONCE on start, so a working session with no
 * LinkedAgent auto-captures the credential ("No LinkedAgent for claude_code").
 *
 * The backend (`POST /api/plugin/agents/claude_code/credential-sync`) is the
 * authority: it auto-creates the LinkedAgent when none exists and NEVER clobbers
 * a durable non-rotating setup-token — so this is safe to run broadly.
 *
 * NOT polling (repo rule): a chokidar fs-event watcher (same primitive as the
 * baton transcript-mirror), reacting to the OS write event — never a
 * `setInterval` that re-reads state on a timer.
 */

import chokidar from 'chokidar';
import * as crypto from 'node:crypto';

import { log } from '../../services/logger';
import { postCredentialSync } from '../acp/backend-reports';
import { claudeCredentialsPaths, extractLocalClaudeToken } from './local-token';

export interface CredentialSyncOptions {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  pollSecret?: string;
  /** Injectable for tests — defaults to the real POST + real reader. */
  push?: typeof postCredentialSync;
  read?: typeof extractLocalClaudeToken;
}

export interface CredentialSyncHandle {
  stop: () => Promise<void>;
  /** Exposed for tests — force a sync pass. */
  syncNow: () => Promise<void>;
}

/** The public LinkedAgent id the backend keys Claude credentials under. */
const CLAUDE_PUBLIC_AGENT_ID = 'claude_code';

export function startClaudeCredentialSync(opts: CredentialSyncOptions): CredentialSyncHandle {
  const push = opts.push ?? postCredentialSync;
  const read = opts.read ?? extractLocalClaudeToken;
  let lastHash = '';
  let stopped = false;

  const syncNow = async (): Promise<void> => {
    if (stopped) return;
    try {
      const tok = await read();
      if (!tok || !tok.credential) return;
      const hash = crypto.createHash('sha256').update(tok.credential).digest('hex');
      if (hash === lastHash) return; // unchanged since last push — no-op
      lastHash = hash;
      await push({
        agent: CLAUDE_PUBLIC_AGENT_ID,
        sessionId: opts.sessionId,
        pluginId: opts.pluginId,
        pluginAuthToken: opts.pluginAuthToken,
        pollSecret: opts.pollSecret,
        method: 'oauth',
        credential: tok.credential,
        agentState: tok.agentState,
      });
      log.trace('cred-sync', 'pushed fresh claude credential to the vault');
    } catch {
      // Best-effort — keeping the vault fresh must never break the session.
    }
  };

  const watcher = chokidar.watch(claudeCredentialsPaths(), {
    ignoreInitial: true,
    // Debounce a rotation's multi-write until the file settles before reading.
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  });
  watcher.on('add', () => void syncNow());
  watcher.on('change', () => void syncNow());
  watcher.on('error', () => {
    /* watcher errors are non-fatal — the initial + future syncs still try */
  });

  // Initial capture on session start — auto-create / freshen without waiting for
  // the next rotation.
  void syncNow();

  return {
    syncNow,
    stop: async () => {
      stopped = true;
      await watcher.close().catch(() => undefined);
    },
  };
}
