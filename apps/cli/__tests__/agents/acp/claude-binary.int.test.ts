// claude-binary.int.test.ts
//
// REAL filesystem integration test for the 2026-07-03 codespace
// regression: the ~250 MB Claude native binary (an OPTIONAL platform
// dependency of @anthropic-ai/claude-agent-sdk) was still downloading
// via `npm install -g codeam-cli` when the agent-spawn gate released,
// so the ACP adapter spawned a binary that wasn't on disk yet →
// "Claude native binary not found for linux-x64".
//
// These tests use a real temp node_modules layout and real timers — no
// fs mocks — so they exercise the exact resolution + wait logic the
// spawn gate now depends on. If a future change stops waiting for the
// binary (or resolves the wrong path), the "appears late" case fails.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveClaudeNativeBinary,
  waitForClaudeNativeBinary,
} from '../../../src/agents/acp/claude-binary';

const PLATFORM = 'linux-x64';

let root: string;
let sdkDir: string;
let binPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bin-'));
  // Mirror the real layout: <root>/@anthropic-ai/claude-agent-sdk (the
  // JS SDK, always present) + a SIBLING platform package that carries
  // the native binary (the optional dep that arrives late).
  sdkDir = path.join(root, '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdkDir, { recursive: true });
  fs.writeFileSync(path.join(sdkDir, 'package.json'), '{"name":"@anthropic-ai/claude-agent-sdk"}');
  binPath = path.join(root, '@anthropic-ai', `claude-agent-sdk-${PLATFORM}`, 'claude');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeBinary(): void {
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(binPath, 'ELF');
}

describe('resolveClaudeNativeBinary (real fs)', () => {
  it('returns null while only the JS SDK is installed (binary still downloading)', () => {
    expect(resolveClaudeNativeBinary({ sdkDir, platformKey: PLATFORM })).toBeNull();
  });

  it('returns the sibling platform binary path once it lands', () => {
    writeBinary();
    expect(resolveClaudeNativeBinary({ sdkDir, platformKey: PLATFORM })).toBe(binPath);
  });

  it('returns null when the SDK itself is absent', () => {
    expect(resolveClaudeNativeBinary({ sdkDir: null, platformKey: PLATFORM })).toBeNull();
  });
});

describe('waitForClaudeNativeBinary (real fs + real timers)', () => {
  it('resolves immediately when the binary is already present', async () => {
    writeBinary();
    const started = Date.now();
    const found = await waitForClaudeNativeBinary({
      sdkDir,
      platformKey: PLATFORM,
      timeoutMs: 2_000,
      pollMs: 50,
    });
    expect(found).toBe(binPath);
    // Fast path — no polling delay.
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('THE REGRESSION: waits and resolves when the binary appears mid-wait', async () => {
    // Simulate npm finishing the 250 MB optional download ~250 ms in.
    const timer = setTimeout(writeBinary, 250);
    try {
      const found = await waitForClaudeNativeBinary({
        sdkDir,
        platformKey: PLATFORM,
        timeoutMs: 3_000,
        pollMs: 40,
      });
      expect(found).toBe(binPath);
    } finally {
      clearTimeout(timer);
    }
  });

  it('gives up (returns null) if the binary never lands within the timeout', async () => {
    const found = await waitForClaudeNativeBinary({
      sdkDir,
      platformKey: PLATFORM,
      timeoutMs: 150,
      pollMs: 30,
    });
    expect(found).toBeNull();
  });
});
