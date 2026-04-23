import pc from 'picocolors';
import { getConfig, setActiveSession, removeSession } from '../config';
import { showIntro, showError } from '../ui/banner';
import { selectSession, confirmAction } from '../ui/prompts';

export async function sessions(args: string[]): Promise<void> {
  const [sub, id] = args;
  if (sub === 'switch') return switchSession();
  if (sub === 'delete') {
    if (!id) {
      showError('Usage: codeam sessions delete <session-id>');
      process.exit(1);
    }
    return deleteSession(id);
  }
  return listSessions();
}

function listSessions(): void {
  showIntro();
  const config = getConfig();

  if (config.sessions.length === 0) {
    console.log(pc.dim('  No paired sessions. Run codeam pair to connect.\n'));
    return;
  }

  console.log(pc.bold('  Paired sessions:\n'));
  for (const s of config.sessions) {
    const isActive = s.id === config.activeSessionId;
    const bullet = isActive ? pc.green('  ●') : pc.dim('  ○');
    const name = isActive ? pc.bold(s.userName) : s.userName;
    const plan = pc.cyan(s.plan);
    const date = pc.dim(new Date(s.pairedAt).toLocaleDateString());
    console.log(`${bullet}  ${name}  ${plan}  ${date}`);
    console.log(pc.dim(`       ${s.id}`));
  }
  console.log('');
}

async function switchSession(): Promise<void> {
  showIntro();
  const config = getConfig();

  if (config.sessions.length === 0) {
    showError('No paired sessions. Run codeam pair to connect.');
    process.exit(1);
  }

  const chosen = await selectSession(config.sessions, config.activeSessionId);
  if (!chosen) { console.log(''); return; }

  setActiveSession(chosen);
  const s = config.sessions.find(x => x.id === chosen);
  console.log(pc.green(`\n  ✓ Switched to ${s?.userName ?? chosen}\n`));
}

async function deleteSession(id: string): Promise<void> {
  showIntro();
  const config = getConfig();
  const session = config.sessions.find(s => s.id === id);

  if (!session) {
    showError(`Session not found: ${id}`);
    process.exit(1);
  }

  const ok = await confirmAction(`Delete session for ${session.userName}?`);
  if (!ok) { console.log(''); return; }

  removeSession(id);
  console.log(pc.green('\n  ✓ Session deleted\n'));
}
