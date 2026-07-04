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
import { createRequire } from 'module';
import {
  resolveClaudeNativeBinary,
  resolveSdkDirViaRequire,
  waitForClaudeNativeBinary,
  waitForCommandOnPath,
} from '../../../src/agents/acp/agent-binary';

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

// ─── SDK dir resolution vs the SDK's exports map (v2.52.8 regression) ──
//
// The Claude SDK's package.json declares an `exports` map that does NOT
// expose `./package.json`, so require.resolve('<sdk>/package.json') throws
// ERR_PACKAGE_PATH_NOT_EXPORTED on the REAL installed package. v2.52.8's
// defaultSdkDir() did exactly that → null → the binary wait NEVER resolved
// → the codespace agent-spawn gate ate its full 240 s timeout on EVERY
// start (confirmed live 2026-07-04 01:18:59→01:22:59). This suite builds a
// real on-disk package with the same restrictive exports map and drives
// REAL Node resolution through it (createRequire — no mocks), so the
// exports-map behaviour itself is what's under test.
describe('resolveSdkDirViaRequire vs exports-map (REAL node resolution)', () => {
  let layout: string;
  let sdkPkgDir: string;
  let req: ReturnType<typeof createRequire>;

  beforeEach(() => {
    // realpath: require.resolve returns resolved paths (/private/var on macOS).
    layout = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-exports-')));
    sdkPkgDir = path.join(layout, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
    fs.mkdirSync(sdkPkgDir, { recursive: true });
    // Same shape as the real SDK: an exports map WITHOUT "./package.json".
    fs.writeFileSync(
      path.join(sdkPkgDir, 'package.json'),
      JSON.stringify({
        name: '@anthropic-ai/claude-agent-sdk',
        version: '0.0.0-test',
        type: 'module',
        exports: { '.': './sdk.mjs' },
      }),
    );
    fs.writeFileSync(path.join(sdkPkgDir, 'sdk.mjs'), 'export const ok = 1;\n');
    // Resolver anchored INSIDE the layout — real Node resolution rules.
    req = createRequire(path.join(layout, 'probe.js'));
  });

  afterEach(() => {
    fs.rmSync(layout, { recursive: true, force: true });
  });

  it('CAPTURES THE ISSUE: resolving <sdk>/package.json throws ERR_PACKAGE_PATH_NOT_EXPORTED', () => {
    // The exact call v2.52.8 relied on — proven broken against a real
    // exports-mapped package. If the SDK ever starts exporting
    // ./package.json this assertion flags that the workaround can go.
    let code: string | undefined;
    try {
      req.resolve('@anthropic-ai/claude-agent-sdk/package.json');
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code;
    }
    expect(code).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });

  it('THE FIX: resolveSdkDirViaRequire finds the package dir via the exported main', () => {
    expect(resolveSdkDirViaRequire(req)).toBe(sdkPkgDir);
  });

  it('end-to-end: the binary resolves using the require-based sdkDir (no explicit sdkDir)', () => {
    const binDir = path.join(layout, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${PLATFORM}`);
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'claude'), 'ELF');
    const found = resolveClaudeNativeBinary({
      sdkDir: resolveSdkDirViaRequire(req),
      platformKey: PLATFORM,
    });
    expect(found).toBe(path.join(binDir, 'claude'));
  });

  it('returns null (not a throw) when the SDK is not installed at all', () => {
    const emptyReq = createRequire(path.join(os.tmpdir(), 'nowhere', 'probe.js'));
    expect(resolveSdkDirViaRequire(emptyReq)).toBeNull();
  });
});

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

// PATH-based agents (codex `npm i -g @openai/codex`, cursor-agent,
// gemini) hit the SAME race — their binary/installer is still running
// when the gate releases. The readiness check polls PATH.
describe('waitForCommandOnPath (codex / cursor / gemini)', () => {
  it('resolves immediately when the command is already on PATH', async () => {
    const started = Date.now();
    const ok = await waitForCommandOnPath('codex', {
      probe: () => true,
      timeoutMs: 2_000,
      pollMs: 50,
    });
    expect(ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('THE REGRESSION (all agents): waits and resolves when the binary appears mid-install', async () => {
    // `npm i -g @openai/codex` finishes ~200 ms in → PATH probe flips true.
    let installed = false;
    setTimeout(() => {
      installed = true;
    }, 200);
    const ok = await waitForCommandOnPath('codex', {
      probe: () => installed,
      timeoutMs: 3_000,
      pollMs: 40,
    });
    expect(ok).toBe(true);
  });

  it('gives up (false) if the command never lands within the timeout', async () => {
    const ok = await waitForCommandOnPath('gemini', {
      probe: () => false,
      timeoutMs: 150,
      pollMs: 30,
    });
    expect(ok).toBe(false);
  });
});
