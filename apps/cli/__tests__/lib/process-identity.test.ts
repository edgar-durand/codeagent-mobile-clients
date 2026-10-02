import { describe, it, expect } from 'vitest';
import { ownerIsAlive, ownerRecord, procStartTime } from '../../src/lib/process-identity';

describe('process identity', () => {
  it('records pid and start time', () => {
    expect(ownerRecord(42, { startTimeOf: () => '777' })).toBe('42 777');
    expect(ownerRecord(42, { startTimeOf: () => '' })).toBe('42');
  });

  it('is alive only when the pid runs AND its start time still matches', () => {
    const alive = { isAlive: () => true, startTimeOf: () => '777' };
    expect(ownerIsAlive('42 777', alive)).toBe(true);
    expect(ownerIsAlive('42 111', alive)).toBe(false);
    expect(ownerIsAlive('42 777', { ...alive, isAlive: () => false })).toBe(false);
  });

  it('falls back to the pid alone when no start time is known', () => {
    expect(ownerIsAlive('42', { isAlive: () => true, startTimeOf: () => '9' })).toBe(true);
    expect(ownerIsAlive('42 777', { isAlive: () => true, startTimeOf: () => '' })).toBe(true);
    expect(ownerIsAlive('garbage', { isAlive: () => true })).toBe(false);
  });

  it('reads this process start time on Linux, never throws elsewhere', () => {
    const t = procStartTime(process.pid);
    if (process.platform === 'linux') expect(t).toMatch(/^\d+$/);
    else expect(t).toBe('');
    expect(procStartTime(2 ** 30)).toBe('');
  });
});
