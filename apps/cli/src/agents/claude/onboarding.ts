import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log } from '../../services/logger';

/**
 * Pre-complete Claude Code's first-run onboarding so it never shows an
 * interactive gate that STALLS the headless ACP agent. Two gates are covered:
 *
 *  1. **First-run theme / welcome picker** (`hasCompletedOnboarding`/`theme`).
 *     In a codespace the HOME is fresh and `~/.claude.json` isn't bridged (house
 *     agent, or any deploy without captured creds), so Claude prompts for a theme
 *     on first launch → the ACP agent + `claude -p` preview prewarm both hang.
 *
 *  2. **Per-workspace "Do you trust this folder?" safety dialog** (⚠️ 2026-07-10
 *     regression). Claude Code v2.1.206+ gates a FRESH directory behind a trust
 *     dialog keyed by project PATH — `projects[<cwd>].hasTrustDialogAccepted`. On
 *     a codespace `/workspaces/<repo>` (and a self-hosted fresh clone) is always
 *     untrusted, so Claude streams the "Quick safety check … 1. Yes / 1. No"
 *     dialog as PLAIN TEXT (no selector → mobile can't answer it) and the turn
 *     wedges. The ACP launch path has no `--dangerously-skip-permissions` (which
 *     the legacy PTY path used to bypass this), so we pre-accept trust for the
 *     session `cwd` here. Pass `cwd` to enable it.
 *
 * Idempotent, strictly non-fatal, and MERGES into any existing config so bridged
 * credentials / project state are kept.
 */
export function ensureClaudeOnboarded(cwd?: string): void {
  try {
    const file = path.join(os.homedir(), '.claude.json');
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      /* missing or unparseable — start from an empty config */
    }

    let changed = false;

    // 1) Global first-run onboarding (theme / welcome picker).
    if (config.hasCompletedOnboarding !== true || typeof config.theme !== 'string') {
      config.hasCompletedOnboarding = true;
      config.theme = typeof config.theme === 'string' ? config.theme : 'dark';
      if (typeof config.lastOnboardingVersion !== 'string') {
        config.lastOnboardingVersion = '2.1.177';
      }
      changed = true;
    }

    // 2) Per-workspace trust — pre-accept the "trust this folder?" dialog for the
    //    session cwd so Claude never asks (headless can't answer).
    if (cwd) {
      const projects =
        config.projects && typeof config.projects === 'object'
          ? (config.projects as Record<string, Record<string, unknown>>)
          : {};
      const entry =
        projects[cwd] && typeof projects[cwd] === 'object' ? projects[cwd] : {};
      if (entry.hasTrustDialogAccepted !== true || entry.hasCompletedProjectOnboarding !== true) {
        entry.hasTrustDialogAccepted = true;
        entry.hasCompletedProjectOnboarding = true;
        projects[cwd] = entry;
        config.projects = projects;
        changed = true;
      }
    }

    if (!changed) return; // already fully onboarded + trusted — leave untouched

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
    log.info(
      'claude',
      `pre-completed Claude onboarding${cwd ? ` + trusted workspace ${cwd}` : ''}`,
    );
  } catch (err) {
    log.warn('claude', `ensureClaudeOnboarded failed (non-fatal): ${(err as Error).message}`);
  }
}
