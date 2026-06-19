import { it, expect } from 'vitest';
import { wrapWithHeadroom } from '../../src/services/headroom/wrap-launch';

const base = { cmd: 'claude', args: ['--session-id', 's1'], env: { FOO: 'bar' } };

it('wraps with `headroom wrap <agent> -- <args>` when enabled + present', () => {
  const out = wrapWithHeadroom(base, { enabled: true, agent: 'claude', headroomPresent: true });
  expect(out.cmd).toBe('headroom');
  expect(out.args).toEqual(['wrap', 'claude', '--', '--session-id', 's1']);
  expect(out.env).toEqual({ FOO: 'bar' });
});

it('returns the launch UNCHANGED when disabled (never-break / not eligible)', () => {
  expect(wrapWithHeadroom(base, { enabled: false, agent: 'claude', headroomPresent: true })).toEqual(base);
});

it('returns the launch UNCHANGED when headroom is not installed (never-break fallback)', () => {
  expect(wrapWithHeadroom(base, { enabled: true, agent: 'claude', headroomPresent: false })).toEqual(base);
});
