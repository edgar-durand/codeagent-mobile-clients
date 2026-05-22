import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { Extension } from 'vscode';

vi.mock('vscode', () => ({}));

vi.mock('../../../src/services/agent-detection/checks/binary');
vi.mock('../../../src/services/agent-detection/checks/config-dir');

import { CodexDetector } from '../../../src/services/agent-detection/detectors/codex.detector';
import * as binaryMod from '../../../src/services/agent-detection/checks/binary';
import * as configDirMod from '../../../src/services/agent-detection/checks/config-dir';

const whichBinary = vi.mocked(binaryMod.whichBinary);
const dirExists = vi.mocked(configDirMod.dirExists);

function ext(id: string): Extension<unknown> {
  return { id } as unknown as Extension<unknown>;
}
const log = {
  appendLine: () => undefined,
} as unknown as Parameters<CodexDetector['detect']>[0]['log'];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CodexDetector', () => {
  test('returns extension result when the official OpenAI extension is installed', async () => {
    const r = await new CodexDetector().detect({
      log,
      extensions: [ext('openai.chatgpt')],
    });
    expect(r).toEqual({
      installed: true,
      extensionId: 'openai.chatgpt',
      isTerminalAgent: true,
      via: 'extension',
    });
    expect(whichBinary).not.toHaveBeenCalled();
  });

  test('falls back to binary when extension absent but `codex` is on PATH', async () => {
    whichBinary.mockResolvedValue('/usr/local/bin/codex');
    const r = await new CodexDetector().detect({ log, extensions: [] });
    expect(r).toEqual({
      installed: true,
      extensionId: '__binary__:codex',
      isTerminalAgent: true,
      via: 'binary',
    });
  });

  test('falls back to config-dir when no extension and no binary but ~/.codex/ exists', async () => {
    whichBinary.mockResolvedValue(null);
    dirExists.mockResolvedValue(true);
    const r = await new CodexDetector().detect({ log, extensions: [] });
    expect(r).toEqual({
      installed: true,
      extensionId: '__config__:codex',
      isTerminalAgent: true,
      via: 'config-dir',
    });
  });

  test('returns null when no signal is found', async () => {
    whichBinary.mockResolvedValue(null);
    dirExists.mockResolvedValue(false);
    expect(await new CodexDetector().detect({ log, extensions: [] })).toBeNull();
  });

  test('always marks isTerminalAgent: true regardless of path', async () => {
    whichBinary.mockResolvedValue('/path/codex');
    const r = await new CodexDetector().detect({ log, extensions: [] });
    expect(r?.isTerminalAgent).toBe(true);
  });

  test('uses detector id "codex" so the fallback wire id is __terminal__:codex', () => {
    expect(new CodexDetector().id).toBe('codex');
  });
});
