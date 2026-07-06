import pc from 'picocolors';
import { resolveApiBaseUrl } from '@codeam/shared';
import { loadCliConfig } from '../config';
import { showIntro } from '../ui/banner';
import { _transport } from '../services/pairing.service';

const API_BASE = resolveApiBaseUrl();

export async function invite(): Promise<void> {
  showIntro();

  const cfg = loadCliConfig();
  const session = cfg.sessions.find((s) => s.id === cfg.activeSessionId) ?? null;

  const pluginAuthToken = session?.pluginAuthToken;
  const sessionId = session?.id;
  const pluginId = session?.pluginId ?? cfg.pluginId;

  if (!pluginAuthToken || !sessionId || !pluginId) {
    console.log(
      pc.yellow('  Not paired yet.') +
        pc.dim('  Run ') +
        pc.cyan('codeam pair') +
        pc.dim(' first, then retry.'),
    );
    console.log('');
    return;
  }

  try {
    const result = await _transport.postJsonAuthed(
      `${API_BASE}/api/referrals/code`,
      { sessionId, pluginId },
      pluginAuthToken,
    );

    const data = (result as Record<string, unknown> | null)?.data as
      | { code: string; link: string }
      | undefined;

    if (!data?.link) {
      console.log(
        pc.red('  Unexpected response from server. Try ') +
          pc.cyan('codeam pair') +
          pc.red(' then retry.'),
      );
      console.log('');
      return;
    }

    console.log(pc.bold('  Invite your crew — unlock PRO for you and them\n'));
    console.log(`  ${pc.bold(pc.cyan(data.link))}`);
    console.log('');
    console.log(
      pc.dim(
        '  Share this link. Every dev who signs up and pairs a session earns you both 14 days of PRO.',
      ),
    );
    console.log('');
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    const code = typeof e.statusCode === 'number' ? e.statusCode : null;
    if (code !== null) {
      console.log(
        pc.red(
          `  Couldn't fetch your invite link (HTTP ${code}). Try ` +
            `\`codeam pair\` then retry.`,
        ),
      );
    } else {
      console.log(
        pc.red("  Couldn't reach the server. Check your connection and try again."),
      );
    }
    console.log('');
  }
}
