import pc from 'picocolors';
import { getConfig } from '../config';
import { showIntro } from '../ui/banner';

export function status(): void {
  showIntro();
  const config = getConfig();
  const active = config.sessions.find(s => s.id === config.activeSessionId) ?? null;

  console.log(pc.bold('  Status\n'));
  console.log(`  Plugin ID   ${pc.dim(config.pluginId || 'not generated yet')}`);
  console.log(`  Sessions    ${config.sessions.length} paired`);

  if (active) {
    console.log(`  Active      ${pc.bold(active.userName)}  ${pc.cyan(active.plan)}`);
    console.log(`  Session ID  ${pc.dim(active.id)}`);
  } else {
    console.log(`  Active      ${pc.yellow('none')}  ${pc.dim('run codeam pair to connect')}`);
  }
  console.log('');
}
