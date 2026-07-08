/**
 * Baton cross-mode-resume — REAL claude integration test.
 *
 * This is NOT a unit test. It proves the feature's linchpin — validated
 * manually during the baton spike, now an automated (gated) check — that a
 * conversation started by the NATIVE `claude` CLI can be resumed through the
 * baton's ACP path (the same {@link AcpDriver} over {@link AcpClient} that
 * `runBatonSession`'s MOBILE driver uses):
 *
 *   1. `claude -p --session-id <uuid> "…"` (native, headless) writes a real
 *      session JSONL under `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.
 *   2. A real {@link AcpClient} spawns the claude ACP adapter
 *      (`@agentclientprotocol/claude-agent-acp`) fresh — `initialize` +
 *      `newSession` — then {@link AcpDriver.start} issues `session/load` for
 *      the id the native CLI just wrote to disk.
 *   3. If step 2 resolves without throwing and returns the SAME id, the
 *      cross-mode resume handshake (spawn + session/load against a
 *      natively-created session) works end-to-end against a real claude
 *      installation — this is what makes "native TUI → take_control (ACP) →
 *      handback" possible at all.
 *
 * Prompting through the resumed ACP session to assert literal recall of the
 * codeword is deliberately NOT attempted here: `AcpDriver` exposes no prompt
 * method (that lives one layer up, in the baton relay's turn dispatch, which
 * is out of scope until the Plan-2 backend integration — see the task-9
 * brief). Asserting the resume call resolves to the native session's id is
 * the strongest claim this layer can make, and it is a REAL claim: a broken
 * adapter spawn, a broken `initialize`/`newSession` handshake, or a rejected
 * `session/load` against a natively-created session would all make this
 * test fail.
 *
 * ── Gating ───────────────────────────────────────────────────────────────
 * Skipped unless `RUN_BATON_INT=1` — CI has no authenticated `claude`, so
 * this never runs there. A developer with a real, logged-in `claude` on
 * PATH runs it explicitly:
 *
 *   RUN_BATON_INT=1 npm run test -- integration/baton-loop
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AcpClient } from '../../src/agents/acp/client';
import { getAcpAdapter } from '../../src/agents/acp/adapters';
import { AcpDriver } from '../../src/baton/acp-driver';

const execFileP = promisify(execFile);

const RUN_BATON_INT = process.env.RUN_BATON_INT === '1';

if (!RUN_BATON_INT) {
  // eslint-disable-next-line no-console
  console.log(
    '[baton-loop] SKIPPED — set RUN_BATON_INT=1 (and have an authenticated `claude` on PATH) to run the real cross-mode-resume gate.',
  );
}

/**
 * Find the session JSONL claude wrote for `sessionId`, without assuming the
 * exact cwd→dirname encoding scheme. We deliberately do NOT reimplement or
 * import `encodeCwd` here: on macOS, `os.tmpdir()` resolves under
 * `/var/folders/<xx>/<yyyy_zzzz>/T/`, and real claude collapses the
 * underscores in that path to dashes when naming the project dir — behavior
 * `encodeCwd` (which only replaces `/ \ :`) does not reproduce. Since the
 * session id is a fresh random UUID, scanning every project dir for a file
 * named exactly `<sessionId>.jsonl` is unambiguous and encoding-agnostic.
 */
function findSessionJsonl(projectsRoot: string, sessionId: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projectsRoot, entry.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

describe.skipIf(!RUN_BATON_INT)('baton cross-mode resume (real claude)', () => {
  it(
    'a session created by the native claude CLI resumes through the baton ACP path (spawn + session/load succeed)',
    async () => {
      // realpath so a symlinked tmp root (e.g. macOS /tmp → /private/tmp)
      // can't make the native CLI and the ACP adapter spawn (step 2, same
      // `cwd`) resolve to two different-looking paths.
      const tempDir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-baton-int-')),
      );
      const sessionId = randomUUID();
      const projectsRoot = path.join(os.homedir(), '.claude', 'projects');

      let driver: AcpDriver | null = null;
      let jsonlPath: string | null = null;
      try {
        // ── Step 1: create a REAL conversation with the NATIVE claude CLI ──
        const { stdout } = await execFileP(
          'claude',
          ['-p', '--session-id', sessionId, 'Remember this codeword: BANANA-7. Reply OK.'],
          { cwd: tempDir, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 },
        );
        expect(stdout.trim().length).toBeGreaterThan(0);
        jsonlPath = findSessionJsonl(projectsRoot, sessionId);
        expect(
          jsonlPath,
          `expected native claude to write a session JSONL for ${sessionId} somewhere under ${projectsRoot}`,
        ).not.toBeNull();

        // ── Step 2: resume it through the baton's REAL ACP path ──
        const adapter = getAcpAdapter('claude');
        if (!adapter) {
          throw new Error(
            'claude ACP adapter not resolvable — is @agentclientprotocol/claude-agent-acp installed?',
          );
        }
        const client = new AcpClient({
          adapter,
          cwd: tempDir,
          onSessionUpdate: () => undefined,
          onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        });
        driver = new AcpDriver({ client });

        // This is the linchpin under test: AcpDriver.start(resumeId) spawns the
        // adapter fresh (initialize + newSession against an EMPTY session),
        // then issues `session/load` for the id the native CLI just wrote to
        // disk. Resolving without throwing — and returning the SAME id —
        // proves cross-mode resume works end-to-end against a real claude
        // installation.
        const resumedId = await driver.start(sessionId);
        expect(resumedId).toBe(sessionId);
      } finally {
        if (driver) {
          await driver.stop().catch(() => undefined);
        }
        if (jsonlPath) {
          // The whole project dir (JSONL + the `memory/` dir claude also
          // writes alongside it) is scoped to our own throwaway temp cwd, so
          // it's safe to remove entirely rather than leaving a stray dir.
          fs.rmSync(path.dirname(jsonlPath), { recursive: true, force: true });
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
