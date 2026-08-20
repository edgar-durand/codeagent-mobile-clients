import { describe, it, expect, vi } from 'vitest';
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { DEFAULT_GUARDRAIL_POLICY, type GuardrailPolicy } from '@codeam/shared';
import {
  createOnRequestPermission,
  pickAllowOption,
  type PermissionGateDeps,
} from '../../../src/agents/acp/permission-gate';

/**
 * The FULL `session/request_permission` decision path, tested exactly as the
 * runner wires it (createOnRequestPermission is the production handler — the
 * runner only injects the real publisher/streaming/policy).
 *
 * Regression suite for the 2026-08-19 P0 (user yunduanmianliu): an
 * ExitPlanMode approval whose PLAN TEXT mentioned
 * `/home/box/.codeam/house-claude/…` was silently auto-rejected by the
 * internal-path guard — no prompt ever reached the phone, the agent said the
 * USER rejected it, plan mode wedged, and a source file was destroyed.
 */

const ALL_DENY: GuardrailPolicy = {
  secretRead: 'deny',
  destructiveShell: 'deny',
  protectedBranch: 'deny',
  outwardIrreversible: 'deny',
};

/** The exact option set claude-agent-acp offers for ExitPlanMode. */
const EXIT_PLAN_OPTIONS: PermissionOption[] = [
  { kind: 'allow_always', name: 'Yes, and use "auto" mode', optionId: 'auto' },
  { kind: 'allow_once', name: 'Yes, and manually approve edits', optionId: 'default' },
  { kind: 'reject_once', name: 'No, keep planning', optionId: 'plan' },
];

const BASH_OPTIONS: PermissionOption[] = [
  { kind: 'allow_always', name: 'Always allow', optionId: 'allow_always' },
  { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
  { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
];

/** The real adapter payload shape for an ExitPlanMode permission request. */
function exitPlanRequest(plan: string): RequestPermissionRequest {
  return {
    sessionId: 's1',
    toolCall: {
      toolCallId: 'toolu_01',
      title: 'Ready to code?',
      kind: 'switch_mode',
      rawInput: { plan },
    },
    options: EXIT_PLAN_OPTIONS,
  };
}

function bashRequest(command: string): RequestPermissionRequest {
  return {
    sessionId: 's1',
    toolCall: { toolCallId: 'toolu_02', title: 'Bash', kind: 'execute', rawInput: { command } },
    options: BASH_OPTIONS,
  };
}

interface GateHarness {
  gate: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  publishAwaitingAnswer: ReturnType<typeof vi.fn>;
  publishOutput: ReturnType<typeof vi.fn>;
  registerPermission: ReturnType<typeof vi.fn>;
}

function makeGate(overrides: Partial<PermissionGateDeps> = {}): GateHarness {
  const publishAwaitingAnswer = vi.fn().mockResolvedValue(undefined);
  const publishOutput = vi.fn().mockResolvedValue(undefined);
  // The interactive path resolves as if the user tapped the FIRST option.
  const registerPermission = vi
    .fn()
    .mockImplementation((args: { optionIdByLabel: Record<string, string> }) => {
      const firstOptionId = Object.values(args.optionIdByLabel)[0];
      return Promise.resolve({ outcome: { outcome: 'selected', optionId: firstOptionId } });
    });
  const gate = createOnRequestPermission({
    autoApprovePermissions: false,
    isLocal: () => false,
    getPolicy: () => DEFAULT_GUARDRAIL_POLICY,
    publisher: { publishAwaitingAnswer, publishOutput },
    registerPermission,
    ...overrides,
  });
  return { gate, publishAwaitingAnswer, publishOutput, registerPermission };
}

describe('permission gate — plan approvals SURFACE even when the plan text mentions internals', () => {
  it('ExitPlanMode with an internal path in the plan text reaches the user (the P0 scenario)', async () => {
    const h = makeGate();
    const res = await h.gate(
      exitPlanRequest(
        'Fix WorldBookEntry.swift. Note: this box runs from /home/box/.codeam/house-claude/workspace.',
      ),
    );
    // The prompt was published to mobile — NOT silently answered.
    expect(h.publishAwaitingAnswer).toHaveBeenCalledTimes(1);
    expect(h.registerPermission).toHaveBeenCalledTimes(1);
    // No auto-block notice, because nothing was auto-blocked.
    expect(h.publishOutput).not.toHaveBeenCalled();
    // The response is whatever the USER picked (harness: first option).
    expect(res).toEqual({ outcome: { outcome: 'selected', optionId: 'auto' } });
  });

  it('ExitPlanMode whose plan mentions rm -rf is not guardrail-blocked either (all-deny policy)', async () => {
    const h = makeGate({ getPolicy: () => ALL_DENY });
    await h.gate(exitPlanRequest('Step 1: rm -rf the stale build dir. Step 2: git push origin main.'));
    expect(h.publishAwaitingAnswer).toHaveBeenCalledTimes(1);
    expect(h.publishOutput).not.toHaveBeenCalled();
  });

  it('AUTO mode auto-approves a clean ExitPlanMode (no human at the phone)', async () => {
    const h = makeGate({ autoApprovePermissions: true });
    const res = await h.gate(exitPlanRequest('Plan: refactor the parser, then run the tests.'));
    expect(res).toEqual({ outcome: { outcome: 'selected', optionId: 'auto' } });
    expect(h.publishAwaitingAnswer).not.toHaveBeenCalled();
  });
});

describe('permission gate — REAL internal file access is still denied, now VISIBLY', () => {
  it('bash cat of ~/.codeam is auto-denied (reject_once) AND publishes a chat notice', async () => {
    const h = makeGate();
    const res = await h.gate(bashRequest('cat ~/.codeam/host-agent.json'));
    expect(res).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
    // The user was never asked…
    expect(h.publishAwaitingAnswer).not.toHaveBeenCalled();
    // …but the auto-decision is VISIBLE in chat and owns the rejection.
    expect(h.publishOutput).toHaveBeenCalledTimes(1);
    const body = h.publishOutput.mock.calls[0][0] as { type: string; content: string; done: boolean };
    expect(body.type).toBe('text');
    expect(body.done).toBe(true);
    expect(body.content).toContain('auto-blocked');
    expect(body.content).toContain('.codeam');
    expect(body.content).toContain('not a rejection by you');
  });

  it('denies even in AUTO mode (guard runs before auto-approve), still visibly', async () => {
    const h = makeGate({ autoApprovePermissions: true });
    const res = await h.gate(bashRequest('ls ~/.codeam/house-claude/'));
    expect(res).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
    expect(h.publishOutput).toHaveBeenCalledTimes(1);
  });

  it('a guardrail Deny is also visible in chat', async () => {
    const h = makeGate({ getPolicy: () => ALL_DENY });
    const res = await h.gate(bashRequest('rm -rf build/'));
    expect(res).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
    expect(h.publishAwaitingAnswer).not.toHaveBeenCalled();
    const body = h.publishOutput.mock.calls[0][0] as { content: string };
    expect(body.content).toContain('Guardrail auto-blocked');
    expect(body.content).toContain('destructiveShell');
    expect(body.content).toContain('not a rejection by you');
  });

  it('a guardrail Confirm routes to the interactive prompt even in AUTO mode', async () => {
    const h = makeGate({ autoApprovePermissions: true });
    await h.gate(bashRequest('git push --force origin main'));
    expect(h.publishAwaitingAnswer).toHaveBeenCalledTimes(1);
    expect(h.publishOutput).not.toHaveBeenCalled();
  });
});

describe('permission gate — ordinary flow is untouched', () => {
  it('a normal request surfaces to the user in manual mode', async () => {
    const h = makeGate();
    await h.gate(bashRequest('npm run build'));
    expect(h.publishAwaitingAnswer).toHaveBeenCalledTimes(1);
    expect(h.publishOutput).not.toHaveBeenCalled();
  });

  it('a normal request auto-approves with the broadest allow in AUTO mode', async () => {
    const h = makeGate({ autoApprovePermissions: true });
    const res = await h.gate(bashRequest('npm run build'));
    expect(res).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_always' } });
  });

  it('a LOCAL session skips both guards entirely (~/.codeam is the user’s own config)', async () => {
    const h = makeGate({ isLocal: () => true, getPolicy: () => ALL_DENY });
    await h.gate(bashRequest('cat ~/.codeam/host-agent.json'));
    expect(h.publishAwaitingAnswer).toHaveBeenCalledTimes(1);
    expect(h.publishOutput).not.toHaveBeenCalled();
  });
});

describe('pickAllowOption (moved from runner — import surface preserved)', () => {
  it('prefers allow_always over allow_once, null when no allow', () => {
    expect(pickAllowOption(BASH_OPTIONS)?.optionId).toBe('allow_always');
    expect(pickAllowOption([{ optionId: 'r', kind: 'reject_once' }])).toBeNull();
  });
});
