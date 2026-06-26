import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { handlers } from '../../src/commands/start/handlers';

function makeCtx(sendResult = vi.fn()) {
  return {
    sessionId: 'sess-1',
    pluginId: 'plug-1',
    pluginAuthToken: 'tok',
    relay: { sendResult },
  } as any;
}

let dir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'envcfg-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
});
afterEach(async () => {
  cwdSpy.mockRestore();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('env_read', () => {
  it('returns exists:false and empty vars when no .env', async () => {
    const sendResult = vi.fn();
    await handlers.env_read(makeCtx(sendResult), { id: 'c1' } as any, {} as any);
    expect(sendResult).toHaveBeenCalledWith('c1', 'completed', { exists: false, vars: [] });
  });
  it('returns parsed vars when .env exists', async () => {
    await fs.writeFile(path.join(dir, '.env'), 'A=1\nB=2\n');
    const sendResult = vi.fn();
    await handlers.env_read(makeCtx(sendResult), { id: 'c2' } as any, {} as any);
    expect(sendResult).toHaveBeenCalledWith('c2', 'completed', {
      exists: true,
      vars: [{ key: 'A', value: '1' }, { key: 'B', value: '2' }],
    });
  });
});
