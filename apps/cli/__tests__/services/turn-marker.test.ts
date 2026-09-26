import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __resetTurnMarkerDepth,
  isProcessMidTurn,
  turnMarkerPath,
  withTurnMarker,
} from '../../src/services/turn-marker';

// The host-agent restarts onto an update only when no session is mid-turn;
// this marker is how a session child says so.
let home: string;
const origHome = process.env.HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-turn-'));
  process.env.HOME = home;
  __resetTurnMarkerDepth();
});
afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('turn marker', () => {
  it('exists while a turn runs and is gone after it, even when it throws', async () => {
    const codeam = path.join(home, '.codeam');
    let seen = false;
    await withTurnMarker(async () => {
      seen = isProcessMidTurn(process.pid, codeam);
    });
    expect(seen).toBe(true);
    expect(isProcessMidTurn(process.pid, codeam)).toBe(false);
    await expect(
      withTurnMarker(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(fs.existsSync(turnMarkerPath(process.pid, codeam))).toBe(false);
  });

  it('overlapping turns keep the marker until the LAST one ends', async () => {
    const codeam = path.join(home, '.codeam');
    let release!: () => void;
    const long = withTurnMarker(() => new Promise<void>((r) => (release = r)));
    await withTurnMarker(async () => undefined);
    expect(isProcessMidTurn(process.pid, codeam)).toBe(true);
    release();
    await long;
    expect(isProcessMidTurn(process.pid, codeam)).toBe(false);
  });

  it('an unknown pid is never mid-turn', () => {
    expect(isProcessMidTurn(undefined)).toBe(false);
  });
});
