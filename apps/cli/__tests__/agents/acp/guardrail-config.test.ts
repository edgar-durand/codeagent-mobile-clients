import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_GUARDRAIL_POLICY } from '@codeam/shared';
import {
  guardrailConfigPath,
  loadGuardrailPolicy,
  getGuardrailPolicy,
  setGuardrailPolicy,
  _resetGuardrailPolicyCache,
} from '../../../src/agents/acp/guardrail-config';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'grd-'));
}

describe('guardrail-config', () => {
  let home: string;
  beforeEach(() => {
    home = tmpHome();
    _resetGuardrailPolicyCache();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    _resetGuardrailPolicyCache();
  });

  it('absent file → default-on policy', () => {
    expect(loadGuardrailPolicy(home)).toEqual(DEFAULT_GUARDRAIL_POLICY);
  });

  it('setGuardrailPolicy normalizes, persists, and updates the cache', () => {
    const p = setGuardrailPolicy({ secretRead: 'deny', destructiveShell: 'off', bogus: 'x' }, home);
    expect(p.secretRead).toBe('deny');
    expect(p.destructiveShell).toBe('off');
    expect(p.protectedBranch).toBe('confirm'); // default fill for a missing key

    const onDisk = JSON.parse(fs.readFileSync(guardrailConfigPath(home), 'utf8'));
    expect(onDisk.secretRead).toBe('deny');

    _resetGuardrailPolicyCache();
    expect(getGuardrailPolicy(home).secretRead).toBe('deny'); // re-loads persisted
  });

  it('bad JSON on disk → default-on', () => {
    fs.mkdirSync(path.dirname(guardrailConfigPath(home)), { recursive: true });
    fs.writeFileSync(guardrailConfigPath(home), '{ not json');
    expect(loadGuardrailPolicy(home)).toEqual(DEFAULT_GUARDRAIL_POLICY);
  });
});
