import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpClient } from '../../src/agents/acp/client';

/**
 * REAL processes, no mocks — because the bug was invisible to every mocked
 * test: they asserted `child.kill` was called, and it was. The child died. Its
 * CHILDREN did not.
 *
 * The adapter is the top of a tree: it spawns the real `claude`, which spawns a
 * `codeam mcp-run` shim per integration, each spawning a vendor MCP server.
 * `stop()` used to SIGTERM the adapter only, so a `reprovisionMcp` respawn left
 * the previous `claude` and ALL its MCP servers alive. On a real box two
 * `claude` processes ran side by side with 28 MCP servers between them, and
 * the orphaned tree's servers died with `write EPIPE` as their reader vanished
 * (rafaelph90.br@gmail.com, 2026-09-03 — the "ClickUp keeps disconnecting"
 * report that two earlier fixes, both about slowness, did not touch).
 *
 * This test stands in a fake adapter that spawns a grandchild, stops the
 * client, and asserts the GRANDCHILD is gone.
 */

// POSIX-only: the fix uses process groups; Windows takes the taskkill path.
const posix = process.platform !== 'win32';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(pred: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

// The fake adapter: writes its grandchild's pid to a file (stdout belongs to
// the client's ACP stream reader, so it is not ours to use), then idles. The
// grandchild also idles. Neither ever speaks ACP — we drive `start()` only far
// enough to have a real child, then `stop()`.
const fakeAdapter = (pidFile: string): string => `
  const { spawn } = require('node:child_process');
  const { writeFileSync } = require('node:fs');
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
  setInterval(() => {}, 1000);
`;

function readPid(file: string): number {
  return existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
}

describe.runIf(posix)('AcpClient.stop() reaps the WHOLE adapter tree', () => {
  const leftovers: number[] = [];
  afterEach(() => {
    for (const pid of leftovers) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  });

  it('kills the grandchild the adapter spawned, not just the adapter', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'acp-reap-')), 'grandchild.pid');
    const client = new AcpClient({
      adapter: { command: process.execPath, args: ['-e', fakeAdapter(pidFile)] },
      cwd: process.cwd(),
      onSessionUpdate: () => undefined,
      onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      onExit: () => undefined,
    } as never);

    // `start()` will time out on the never-answered handshake; we only need it
    // to have spawned the child. Let it run and stop as soon as the tree exists.
    // Not awaited: the fake adapter never answers `initialize`, so `start()`
    // only settles at its own 120 s ceiling — long after this test is done.
    // Its rejection is swallowed; `stop()` is what we are testing.
    void client.start().catch(() => undefined);
    const ok = await waitFor(() => readPid(pidFile) > 0, 4000);
    expect(ok).toBe(true);
    const grandchild = readPid(pidFile);
    const child = (client as unknown as { child: ChildProcess }).child;
    leftovers.push(child.pid as number);
    expect(alive(grandchild)).toBe(true);

    await client.stop();

    // ⚠️ THE assertion. Before the fix the adapter was dead here and this
    // grandchild was still running — for as long as the box lived.
    const gone = await waitFor(() => !alive(grandchild), 4000);
    expect(gone).toBe(true);
    expect(alive(child.pid as number)).toBe(false);
  }, 15_000);
});

describe.runIf(posix)('control: a plain child.kill() does NOT reap the grandchild', () => {
  it('proves the assertion above discriminates', async () => {
    // Same fake adapter, killed the OLD way — leader only, no group. If this
    // grandchild survives, the test above is measuring something real.
    const pidFile = join(mkdtempSync(join(tmpdir(), 'acp-reap-ctl-')), 'grandchild.pid');
    const adapter = spawn(process.execPath, ['-e', fakeAdapter(pidFile)], { stdio: 'ignore' });
    expect(await waitFor(() => readPid(pidFile) > 0, 4000)).toBe(true);
    const grandchild = readPid(pidFile);

    adapter.kill('SIGTERM');
    await waitFor(() => !alive(adapter.pid as number), 4000);

    const orphaned = alive(grandchild);
    try {
      process.kill(grandchild, 'SIGKILL');
    } catch {
      /* gone */
    }
    expect(orphaned).toBe(true);
  }, 15_000);
});
