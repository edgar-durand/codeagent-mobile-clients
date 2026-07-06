import { describe, it, expect, vi } from 'vitest';
import { applyBeadsAction, buildBdArgs } from '../../src/beads/apply-actions';
import type { BdAdapter, BdRunResult } from '../../src/beads/bd-adapter';
import type { BeadsActionPayload } from '@codeam/shared';

function fakeAdapter(result: BdRunResult, available = true): BdAdapter {
  return {
    isAvailable: () => available,
    run: vi.fn().mockResolvedValue(result),
  } as unknown as BdAdapter;
}

const OK: BdRunResult = { code: 0, stdout: '', stderr: '' };

describe('buildBdArgs', () => {
  it('claim → bd update <id> --claim (+ owner)', () => {
    expect(buildBdArgs({ kind: 'claim', issueId: 'bd-1' })).toEqual([
      'update',
      'bd-1',
      '--claim',
    ]);
    expect(buildBdArgs({ kind: 'claim', issueId: 'bd-1', owner: 'claude' })).toEqual([
      'update',
      'bd-1',
      '--claim',
      '--owner',
      'claude',
    ]);
  });

  it('close → bd close <id> (+ reason)', () => {
    expect(buildBdArgs({ kind: 'close', issueId: 'bd-1', reason: 'done' })).toEqual([
      'close',
      'bd-1',
      '--reason',
      'done',
    ]);
  });

  it('create → bd create <title>', () => {
    expect(buildBdArgs({ kind: 'create', text: 'fix the bug' })).toEqual([
      'create',
      'fix the bug',
    ]);
  });

  it('remember → bd remember <body>', () => {
    expect(buildBdArgs({ kind: 'remember', text: 'we use SSE not polling' })).toEqual([
      'remember',
      'we use SSE not polling',
    ]);
  });

  it('returns null for malformed actions (missing required field)', () => {
    expect(buildBdArgs({ kind: 'claim' })).toBeNull();
    expect(buildBdArgs({ kind: 'close' })).toBeNull();
    expect(buildBdArgs({ kind: 'create', text: '   ' })).toBeNull();
    expect(buildBdArgs({ kind: 'remember' })).toBeNull();
  });
});

describe('applyBeadsAction', () => {
  it('runs the native bd command then triggers a push', async () => {
    const adapter = fakeAdapter(OK);
    const onApplied = vi.fn().mockResolvedValue(undefined);
    const action: BeadsActionPayload = { kind: 'close', issueId: 'bd-1', reason: 'shipped' };

    const res = await applyBeadsAction(action, { adapter, onApplied });

    expect(res.ok).toBe(true);
    expect(adapter.run).toHaveBeenCalledWith(['close', 'bd-1', '--reason', 'shipped']);
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it('claims an issue as a native bd update --claim', async () => {
    const adapter = fakeAdapter(OK);
    const onApplied = vi.fn().mockResolvedValue(undefined);
    await applyBeadsAction({ kind: 'claim', issueId: 'bd-9', owner: 'codex' }, { adapter, onApplied });
    expect(adapter.run).toHaveBeenCalledWith(['update', 'bd-9', '--claim', '--owner', 'codex']);
  });

  it('rejects a malformed action without spawning bd or pushing', async () => {
    const adapter = fakeAdapter(OK);
    const onApplied = vi.fn();
    const res = await applyBeadsAction({ kind: 'claim' }, { adapter, onApplied });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('malformed');
    expect(adapter.run).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('fails (no push) when bd is unavailable', async () => {
    const adapter = fakeAdapter(OK, false);
    const onApplied = vi.fn();
    const res = await applyBeadsAction({ kind: 'create', text: 'x' }, { adapter, onApplied });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('unavailable');
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('reports failure (no push) when the bd command exits non-zero', async () => {
    const adapter = fakeAdapter({ code: 2, stdout: '', stderr: 'no such issue' });
    const onApplied = vi.fn();
    const res = await applyBeadsAction({ kind: 'close', issueId: 'bd-missing' }, { adapter, onApplied });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(2);
    expect(res.error).toContain('no such issue');
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('still reports success when the post-action push throws (state is local)', async () => {
    const adapter = fakeAdapter(OK);
    const onApplied = vi.fn().mockRejectedValue(new Error('network down'));
    const res = await applyBeadsAction({ kind: 'create', text: 'task' }, { adapter, onApplied });
    expect(res.ok).toBe(true); // bd mutation already landed on the station
  });
});
