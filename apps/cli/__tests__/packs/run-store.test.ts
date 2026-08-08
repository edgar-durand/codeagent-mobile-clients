import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PackRunState } from '@codeam/shared';
import {
  ensureLedgerIgnored,
  loadLatestRun,
  newRunId,
  saveRun,
  saveStageHandoff,
} from '../../src/packs/run-store';

function state(runId: string, status: PackRunState['status']): PackRunState {
  return {
    runId,
    packId: 'quick-pack',
    task: 't',
    status,
    currentStage: 0,
    stages: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('pack run-store (the workspace ledger)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-store-'));
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('saveRun + loadLatestRun round-trip; newest run wins', () => {
    saveRun(cwd, state('pk_aaa', 'completed'));
    saveRun(cwd, state('pk_bbb', 'running'));
    expect(loadLatestRun(cwd)?.runId).toBe('pk_bbb');
  });

  it('loadLatestRun is null on a fresh workspace', () => {
    expect(loadLatestRun(cwd)).toBeNull();
  });

  it('saveStageHandoff writes the human-auditable per-stage file', () => {
    saveStageHandoff(cwd, 'pk_x', 0, 'coder', {
      commit: 'abcdef1234',
      summary: 's',
      diffStat: 'd',
      durationMs: 5,
    });
    const file = path.join(cwd, '.codeam', 'packs', 'pk_x', '01-coder.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).commit).toBe('abcdef1234');
  });

  it('ensureLedgerIgnored appends to .git/info/exclude once, idempotently', () => {
    fs.mkdirSync(path.join(cwd, '.git', 'info'), { recursive: true });
    ensureLedgerIgnored(cwd);
    ensureLedgerIgnored(cwd);
    const exclude = fs.readFileSync(path.join(cwd, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.match(/\.codeam\/packs\//g)).toHaveLength(1);
  });

  it('ensureLedgerIgnored is a no-op outside a git repo (never throws)', () => {
    expect(() => ensureLedgerIgnored(cwd)).not.toThrow();
    expect(fs.existsSync(path.join(cwd, '.git'))).toBe(false);
  });

  it('newRunId is unique and filename-safe', () => {
    const a = newRunId();
    const b = newRunId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^pk_[a-z0-9_]+$/);
  });
});
