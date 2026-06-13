import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log } from '../../services/logger';

/**
 * Pre-complete Claude Code's first-run onboarding so it never shows the
 * interactive theme / welcome picker.
 *
 * In a codespace the HOME is fresh and `~/.claude.json` isn't bridged (house
 * agent, or any deploy without captured creds), so Claude v2.1.177 prompts for
 * a theme on first launch. That interactive prompt STALLS the headless ACP
 * agent (mobile shows the ASCII welcome + "Choose the text style") AND the
 * `claude -p` preview-detection prewarm — both hang waiting for a selection
 * that never arrives, so the agent looks broken and the preview never detects.
 *
 * Writing the onboarding flags up front makes Claude start headless. Idempotent
 * (no-op once onboarding is marked complete), strictly non-fatal, and it MERGES
 * into any existing config so bridged credentials / project state are kept.
 */
export function ensureClaudeOnboarded(): void {
  try {
    const file = path.join(os.homedir(), '.claude.json');
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      /* missing or unparseable — start from an empty config */
    }
    if (config.hasCompletedOnboarding === true && typeof config.theme === 'string') {
      return; // already onboarded — leave it untouched
    }
    config.hasCompletedOnboarding = true;
    config.theme = typeof config.theme === 'string' ? config.theme : 'dark';
    if (typeof config.lastOnboardingVersion !== 'string') {
      config.lastOnboardingVersion = '2.1.177';
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
    log.info('claude', 'pre-completed Claude onboarding (skip first-run theme picker)');
  } catch (err) {
    log.warn('claude', `ensureClaudeOnboarded failed (non-fatal): ${(err as Error).message}`);
  }
}
