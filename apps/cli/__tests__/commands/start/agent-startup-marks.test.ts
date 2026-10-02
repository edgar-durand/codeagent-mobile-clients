import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  markAgentStarting,
  otherAgentsStarting,
  waitForNoAgentStarting,
} from '../../../src/commands/start/agent-startup-marks';

// codeagent-w683: beads provisioning on one session must not compete with
// another session's agent startup on the same machine.
describe('agent startup marks', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w683-marks-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a mark is visible to other processes until released; release is idempotent', () => {
    const release = markAgentStarting({ dir, pid: 101 });
    expect(otherAgentsStarting({ dir, pid: 202, isAlive: () => true })).toEqual([101]);
    // a process never waits on its own mark
    expect(otherAgentsStarting({ dir, pid: 101, isAlive: () => true })).toEqual([]);
    release();
    release();
    expect(otherAgentsStarting({ dir, pid: 202, isAlive: () => true })).toEqual([]);
  });

  it('drops marks whose owner is dead or that are too old to be a live handshake', () => {
    markAgentStarting({ dir, pid: 101 });
    markAgentStarting({ dir, pid: 102 });
    const old = (Date.now() - 10 * 60_000) / 1000;
    fs.utimesSync(path.join(dir, '102'), old, old);
    expect(otherAgentsStarting({ dir, pid: 1, isAlive: (p) => p !== 101 })).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('ignores a mark whose pid now belongs to a different process (container restart)', () => {
    markAgentStarting({ dir, pid: 22, startTimeOf: () => '5000' });
    expect(
      otherAgentsStarting({ dir, pid: 1, isAlive: () => true, startTimeOf: () => '9000' }),
    ).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('waits while another agent is starting and resolves once it releases', async () => {
    const release = markAgentStarting({ dir, pid: 101 });
    let polls = 0;
    await waitForNoAgentStarting({
      dir,
      pid: 202,
      isAlive: () => true,
      timeoutMs: 60_000,
      sleep: async () => {
        polls += 1;
        if (polls === 3) release();
      },
    });
    expect(polls).toBe(3);
  });

  it('gives up at the timeout when a mark never goes away', async () => {
    markAgentStarting({ dir, pid: 101 });
    let t = 0;
    await waitForNoAgentStarting({
      dir,
      pid: 202,
      isAlive: () => true,
      timeoutMs: 2_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(t).toBeGreaterThanOrEqual(2_000);
  });

  it('is a no-op when the marks directory cannot be written', () => {
    const file = path.join(dir, 'not-a-dir');
    fs.writeFileSync(file, '');
    const release = markAgentStarting({ dir: path.join(file, 'marks'), pid: 101 });
    expect(() => release()).not.toThrow();
    expect(otherAgentsStarting({ dir: path.join(file, 'marks'), pid: 1 })).toEqual([]);
  });
});
