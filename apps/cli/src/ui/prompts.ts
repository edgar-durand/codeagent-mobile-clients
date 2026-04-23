import * as p from '@clack/prompts';
import type { SavedSession } from '../config';

export { p };

export async function confirmAction(message: string): Promise<boolean> {
  const result = await p.confirm({ message });
  if (p.isCancel(result)) return false;
  return result as boolean;
}

export async function selectSession(
  sessions: SavedSession[],
  activeId: string | null,
): Promise<string | null> {
  const result = await p.select({
    message: 'Select active session:',
    options: sessions.map(s => ({
      value: s.id,
      label: `${s.userName}  ${s.plan}`,
      hint: s.id === activeId ? 'active' : `paired ${new Date(s.pairedAt).toLocaleDateString()}`,
    })),
    initialValue: activeId ?? undefined,
  });
  if (p.isCancel(result)) return null;
  return result as string;
}
