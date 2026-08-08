import { describe, it, expect } from 'vitest';
import { DEFAULT_GUARDRAIL_POLICY, type GuardrailPolicy } from '@codeam/shared';
import {
  guardrailDecision,
  toolPathIsSecret,
  type GuardrailPermissionRequest,
} from '../../../src/agents/acp/guardrails';

const OPTS: GuardrailPermissionRequest['options'] = [
  { optionId: 'allow', kind: 'allow_once' },
  { optionId: 'always', kind: 'allow_always' },
  { optionId: 'no', kind: 'reject_once' },
  { optionId: 'never', kind: 'reject_always' },
];

function req(title: string, rawInput?: unknown): GuardrailPermissionRequest {
  return { toolCall: { title, kind: 'execute', rawInput }, options: OPTS };
}

const ALL_CONFIRM = DEFAULT_GUARDRAIL_POLICY;
const ALL_DENY: GuardrailPolicy = {
  secretRead: 'deny',
  destructiveShell: 'deny',
  protectedBranch: 'deny',
  outwardIrreversible: 'deny',
};
const ALL_OFF: GuardrailPolicy = {
  secretRead: 'off',
  destructiveShell: 'off',
  protectedBranch: 'off',
  outwardIrreversible: 'off',
};

describe('guardrailDecision — category detection', () => {
  it('flags rm -rf as destructiveShell', () => {
    const d = guardrailDecision(req('Run command', { command: 'rm -rf build/' }), ALL_CONFIRM);
    expect(d?.kind).toBe('confirm');
    expect(d?.category).toBe('destructiveShell');
  });

  it('flags git reset --hard as destructiveShell', () => {
    expect(
      guardrailDecision(req('', { command: 'git reset --hard origin/main' }), ALL_CONFIRM)?.category,
    ).toBe('destructiveShell');
  });

  it('flags git push origin main as protectedBranch', () => {
    expect(guardrailDecision(req('git push origin main'), ALL_CONFIRM)?.category).toBe('protectedBranch');
  });

  it('flags force-push as outwardIrreversible', () => {
    expect(
      guardrailDecision(req('', { command: 'git push --force origin feature' }), ALL_CONFIRM)?.category,
    ).toBe('outwardIrreversible');
  });

  it('flags npm publish as outwardIrreversible', () => {
    expect(guardrailDecision(req('', { command: 'npm publish' }), ALL_CONFIRM)?.category).toBe(
      'outwardIrreversible',
    );
  });

  it('flags reading .env as secretRead', () => {
    expect(guardrailDecision(req('', { command: 'cat .env' }), ALL_CONFIRM)?.category).toBe('secretRead');
    expect(guardrailDecision(req('Read', { path: 'config/.env.production' }), ALL_CONFIRM)?.category).toBe(
      'secretRead',
    );
  });

  it('does NOT flag process.env / a benign build command', () => {
    expect(guardrailDecision(req('', { command: 'echo $process.env.NODE_ENV' }), ALL_CONFIRM)).toBeNull();
    expect(guardrailDecision(req('', { command: 'npm run build' }), ALL_CONFIRM)).toBeNull();
    expect(guardrailDecision(req('', { command: 'ls -la src/' }), ALL_CONFIRM)).toBeNull();
  });
});

describe('guardrailDecision — disposition', () => {
  it('deny → a reject outcome (broadest reject option)', () => {
    const d = guardrailDecision(req('', { command: 'rm -rf /' }), ALL_DENY);
    expect(d?.kind).toBe('deny');
    if (d?.kind === 'deny') {
      expect(d.outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'never' } });
    }
  });

  it('cancels when the agent offers no reject option', () => {
    const d = guardrailDecision(
      { toolCall: { title: 'rm -rf x', kind: 'execute' }, options: [{ optionId: 'ok', kind: 'allow_once' }] },
      ALL_DENY,
    );
    expect(d?.kind).toBe('deny');
    if (d?.kind === 'deny') expect(d.outcome).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('off → null (no interception)', () => {
    expect(guardrailDecision(req('', { command: 'rm -rf build' }), ALL_OFF)).toBeNull();
  });

  it('picks the strongest disposition across multiple matched categories (force-push to main)', () => {
    // Matches BOTH protectedBranch and outwardIrreversible.
    const policy: GuardrailPolicy = { ...ALL_OFF, protectedBranch: 'deny', outwardIrreversible: 'confirm' };
    const d = guardrailDecision(req('', { command: 'git push --force origin main' }), policy);
    expect(d?.kind).toBe('deny');
    expect(d?.category).toBe('protectedBranch');
  });
});

describe('toolPathIsSecret (fs-seam belt)', () => {
  it('matches secret paths, not ordinary source', () => {
    expect(toolPathIsSecret('/app/.env')).toBe(true);
    expect(toolPathIsSecret('/app/certs/server.key')).toBe(true);
    expect(toolPathIsSecret('/app/src/index.ts')).toBe(false);
  });
});
