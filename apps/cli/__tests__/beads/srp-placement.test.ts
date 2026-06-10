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

  it('the provisioner DOES run `bd setup <recipe> --global` (D12 — REVISED: native agent wiring)', () => {
    // Strip comments first so the explanatory prose doesn't create false
    // positives — we only want a real `['setup', …, '--global']` argv.
    const code = read('beads/provisioner.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).toContain("'setup'");
    expect(code).toContain("'--global'");
    // …and it is gated by `--check` (idempotent).
    expect(code).toContain("'--check'");
  });

  it('runAcpSession does NOT run `bd setup` (SRP holds — setup is a composition-root concern)', () => {
    // The agent runner must carry zero beads-setup code; the wiring (setup
    // included) runs in the provisioner / composition root, not the runner.
    const runner = read('agents/acp/runner.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(runner).not.toContain("'setup'");
    expect(runner).not.toContain('bd setup');
  });
});
