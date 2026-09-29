import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  readActiveConversationMarker,
  writeActiveConversationMarker,
} from '../../../src/services/active-conversation-marker';
import { pickLatestResumableConversation } from '../../../src/agents/acp/runner';

/**
 * Host-agent RESUME boot — which conversation to load. A one-shot (`claude -p`
 * for the AI summary / preview detect) writes its own transcript in the same
 * project dir, so "most recent" resumed the summary prompt instead of the
 * user's conversation after a Box wake (QA box, 2026-09-29). The runner now
 * records the conversation it drives; the picker prefers that record.
 */
const FRESH = 'fresh-0000';
const USER = 'user-1111';
const ONE_SHOT = 'oneshot-2222';
const listed = [
  { id: USER, timestamp: 1_000 },
  { id: ONE_SHOT, timestamp: 2_000 }, // newer: the AI-summary one-shot
  { id: FRESH, timestamp: 3_000 },
];

describe('pickLatestResumableConversation', () => {
  it('prefers the marked (driven) conversation over a newer one-shot transcript', () => {
    expect(pickLatestResumableConversation(listed, FRESH, USER)).toBe(USER);
  });

  it('resumes nothing when the marked conversation has no transcript (zero turns)', () => {
    expect(pickLatestResumableConversation(listed, FRESH, 'never-typed')).toBeNull();
  });

  it('keeps the legacy most-recent rule when there is no marker (older CLI sessions)', () => {
    expect(pickLatestResumableConversation(listed, FRESH, null)).toBe(ONE_SHOT);
    expect(pickLatestResumableConversation(listed, FRESH)).toBe(ONE_SHOT);
  });

  it('never picks the fresh session itself, marked or not', () => {
    expect(pickLatestResumableConversation(listed, FRESH, FRESH)).toBeNull();
    expect(pickLatestResumableConversation([{ id: FRESH, timestamp: 1 }], FRESH)).toBeNull();
  });
});

describe('resume pick over a list with a registered one-shot', () => {
  it('never picks a one-shot transcript, even when it is the newest', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-conv-oneshot-home-'));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const { registerOneShotConversation } =
        await import('../../../src/services/oneshot-registry');
      const { AcpClient } = await import('../../../src/agents/acp/client');
      registerOneShotConversation('/tmp/w', ONE_SHOT);
      const client = new AcpClient({
        adapter: {
          command: 'x',
          args: [],
          requiresAgentBinary: 'x',
          waitForBinary: async () => true,
        },
        cwd: '/tmp/w',
        onSessionUpdate: () => undefined,
        onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      });
      const internals = client as unknown as {
        connection: { listSessions: () => Promise<unknown> };
        supportsListSessions: boolean;
      };
      internals.supportsListSessions = true;
      internals.connection = {
        listSessions: async () => ({
          sessions: listed.map((s) => ({
            sessionId: s.id,
            updatedAt: new Date(s.timestamp).toISOString(),
          })),
        }),
      };
      // No marker (legacy rule): the newest non-fresh row would be the one-shot.
      expect(pickLatestResumableConversation(await client.listSessions(), FRESH, null)).toBe(USER);
    } finally {
      process.env.HOME = prevHome;
    }
  });
});

describe('active conversation marker', () => {
  let cwd: string;
  let home: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-conv-marker-cwd-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-conv-marker-home-'));
  });

  it('round-trips outside the project tree, keyed by cwd', async () => {
    await writeActiveConversationMarker(cwd, USER, home);
    expect(await readActiveConversationMarker(cwd, home)).toBe(USER);
    expect(fs.readdirSync(cwd)).toEqual([]);
    expect(await readActiveConversationMarker(path.join(cwd, 'other'), home)).toBeNull();
  });

  it('the last re-point wins', async () => {
    await writeActiveConversationMarker(cwd, USER, home);
    await writeActiveConversationMarker(cwd, ONE_SHOT, home);
    expect(await readActiveConversationMarker(cwd, home)).toBe(ONE_SHOT);
  });

  it('reads null for a missing or malformed marker', async () => {
    expect(await readActiveConversationMarker(cwd, home)).toBeNull();
    const dir = path.join(home, '.codeam', 'conversation-active');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.writeFileSync(path.join(dir, f), '{');
    await writeActiveConversationMarker(cwd, USER, home);
    const [file] = fs.readdirSync(dir);
    fs.writeFileSync(path.join(dir, file), '{"conversationId":42}');
    expect(await readActiveConversationMarker(cwd, home)).toBeNull();
  });
});

describe('shouldRecordConversationAfterBoot', () => {
  it('records a fresh session and a marked resume, never a legacy (unmarked) guess', async () => {
    const { shouldRecordConversationAfterBoot } = await import('../../../src/agents/acp/runner');
    expect(
      shouldRecordConversationAfterBoot({ resumedPriorConversation: false, marked: null }),
    ).toBe(true);
    expect(
      shouldRecordConversationAfterBoot({ resumedPriorConversation: true, marked: USER }),
    ).toBe(true);
    expect(
      shouldRecordConversationAfterBoot({ resumedPriorConversation: true, marked: null }),
    ).toBe(false);
  });
});
