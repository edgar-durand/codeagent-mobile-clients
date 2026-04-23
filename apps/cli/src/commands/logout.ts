import pc from 'picocolors';
import { clearAll } from '../config';
import { showIntro } from '../ui/banner';
import { confirmAction } from '../ui/prompts';

export async function logout(): Promise<void> {
  showIntro();
  const ok = await confirmAction('Remove all sessions and local config?');
  if (!ok) { console.log(''); return; }
  clearAll();
  console.log(pc.green('\n  ✓ Done. All sessions removed.\n'));
}
