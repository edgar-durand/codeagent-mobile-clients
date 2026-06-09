import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SRP guard (decision D10): Beads provisioning is a composition-root concern.
 * It MUST run from the CLI's shared start path (`start()` + `startInfraOnly()`)
 * and MUST NOT run from the agent runner (`runAcpSession`). These source-level
 * assertions fail loudly if a future change re-couples provisioning into the
 * runner — the exact regression this refactor undid.
 */

const SRC = path.resolve(__dirname, '../../src');

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

describe('Beads provisioning placement (SRP / D10)', () => {
  it('runAcpSession does NOT provision beads (no provisioner / wiring entry call)', () => {
    const runner = read('agents/acp/runner.ts');
    // The runner must not call the composition-root provisioning entry…
    expect(runner).not.toContain('provisionBeadsForStart');
    // …nor reach into the orchestrator's startBeads / provisioner directly.
    expect(runner).not.toContain('provisionBeads');
    expect(runner).not.toContain('startBeads(');
  });

  it('runAcpSession receives the live beads handle via an injected accessor', () => {
    const runner = read('agents/acp/runner.ts');
    expect(runner).toContain('getBeads');
  });

  it('start() provisions beads from the composition root', () => {
    const start = read('commands/start.ts');
    expect(start).toContain('provisionBeadsForStart');
  });

  it('startInfraOnly() provisions beads from the composition root', () => {
    const infra = read('commands/start-infra-only.ts');
    expect(infra).toContain('provisionBeadsForStart');
  });

  it('no code path runs `bd setup <recipe>` (P0 must not mutate workspace files / D12)', () => {
    // Walk the whole beads module — none of it may invoke `bd setup`.
    const beadsDir = path.join(SRC, 'beads');
    const offenders: string[] = [];
    for (const f of fs.readdirSync(beadsDir)) {
      if (!f.endsWith('.ts')) continue;
      // Strip comments first so the provisioner's explanatory "we do NOT run
      // `bd setup`" note isn't a false positive — we only want real code.
      const code = fs
        .readFileSync(path.join(beadsDir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      // Flag a literal `setup` argv element handed to bd (e.g. ['setup', …]).
      if (/['"]setup['"]/.test(code)) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });
});
