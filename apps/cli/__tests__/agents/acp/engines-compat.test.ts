import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Regression net for the 2026-07-16 incident: bumping
 * `@agentclientprotocol/claude-agent-acp` 0.47.0 → 0.59.0 to fix the ACP chat
 * silently raised the adapter's `engines.node` to ">=22". Every test + the
 * canary ran on node 22/24 (CI runners, a dev mac), so nothing caught it — but
 * the self-hosted boxes, codespaces, and the rescue-fleet all run node 20, where
 * the adapter crashes on spawn and the chat is dead. `command: process.execPath`
 * means the adapter runs on the SAME node that runs the CLI, so our declared
 * node floor MUST be >= every spawned adapter's floor, and every environment we
 * actually ship (the box image here; the codespace bootstrap node in api-v2 has
 * its own mirror test) MUST meet that floor.
 *
 * This is a STATIC contract check — it runs on any node and fails the instant an
 * adapter (or a shipped runtime) drifts below what we run.
 */

/** Lowest major that satisfies an `engines.node` range (">=22", ">=20.0.0"). undefined/none → 0. */
function minMajor(range: string | undefined): number {
  if (!range) return 0;
  const m = range.match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

const cliPkg = require('../../../package.json');
const OUR_MIN_MAJOR = minMajor(cliPkg.engines?.node);

// The ACP adapters we spawn with `process.execPath` (see src/agents/acp/adapters.ts REGISTRY).
const SPAWNED_ADAPTERS = [
  '@agentclientprotocol/claude-agent-acp',
  '@agentclientprotocol/codex-acp',
];

describe('ACP adapter ↔ node-engine compatibility', () => {
  it('the CLI declares a concrete node floor', () => {
    expect(OUR_MIN_MAJOR).toBeGreaterThanOrEqual(20);
  });

  for (const pkg of SPAWNED_ADAPTERS) {
    it(`${pkg} can run on our declared node floor (>=${OUR_MIN_MAJOR})`, () => {
      const adapterPkg = require(`${pkg}/package.json`);
      const adapterMin = minMajor(adapterPkg.engines?.node);
      // Our node must be >= the adapter's required node, or it crashes on spawn.
      expect(adapterMin).toBeLessThanOrEqual(OUR_MIN_MAJOR);
    });
  }

  it('the box image node major meets our declared node floor', () => {
    // apps/box/Dockerfile is the rescue-fleet / self-hosted-box runtime.
    const dockerfile = readFileSync(
      join(__dirname, '../../../../box/Dockerfile'),
      'utf8',
    );
    const m = dockerfile.match(/^FROM\s+node:(\d+)-/m);
    expect(m, 'Dockerfile must pin a node:<major>-* base image').not.toBeNull();
    const boxMajor = Number(m![1]);
    expect(boxMajor).toBeGreaterThanOrEqual(OUR_MIN_MAJOR);
  });
});
