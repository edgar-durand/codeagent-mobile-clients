/**
 * Regression test for the macOS `spawn ENOEXEC` bug.
 *
 * REAL-WORLD FAILURE (June 2026): a user running the local preview on macOS
 * (Apple Silicon, `/opt/homebrew`) hit `Error: spawn ENOEXEC` when the CLI
 * tried to launch cloudflared. Root cause: Cloudflare ships macOS builds as a
 * gzipped tarball (`cloudflared-darwin-arm64.tgz`), but `downloadCloudflared`
 * wrote the `.tgz` bytes straight to `~/.codeam/bin/cloudflared` and chmod +x'd
 * them. The cached "binary" was actually gzip data → `spawn` failed ENOEXEC.
 * Linux ships the raw binary (no .tgz), which is why codespaces were unaffected.
 *
 * The fix extracts the tarball on macOS and self-heals a gzip-corrupt cache.
 * These tests pin both behaviours with a real `.tgz` + the system `tar`.
 */

import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractTgz, isExecutableBinary } from '../../src/services/preview/cloudflared';

const execFileAsync = promisify(execFile);

let workDir: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-extract-'));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('isExecutableBinary', () => {
  it('rejects a gzip archive (the pre-fix corrupt cache that spawned ENOEXEC)', async () => {
    const gz = path.join(workDir, 'cloudflared');
    // gzip magic: 0x1f 0x8b — exactly what the old code wrote to the binary path.
    await fs.writeFile(gz, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00]));
    expect(await isExecutableBinary(gz)).toBe(false);
  });

  it('accepts a real (non-gzip) binary', async () => {
    const bin = path.join(workDir, 'cloudflared');
    // A Mach-O-ish magic — anything that is not the gzip 0x1f8b header.
    await fs.writeFile(bin, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00]));
    expect(await isExecutableBinary(bin)).toBe(true);
  });

  it('returns false for a missing file', async () => {
    expect(await isExecutableBinary(path.join(workDir, 'nope'))).toBe(false);
  });
});

describe('extractTgz', () => {
  it('extracts the cloudflared binary from a .tgz into an executable file (not gzip)', async () => {
    // Build a realistic macOS-style tarball: a single top-level `cloudflared`.
    const srcDir = path.join(workDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    const payload = '#!/bin/sh\necho fake-cloudflared\n';
    await fs.writeFile(path.join(srcDir, 'cloudflared'), payload, { mode: 0o755 });
    const tgz = path.join(workDir, 'cloudflared-darwin-arm64.tgz');
    await execFileAsync('tar', ['-czf', tgz, '-C', srcDir, 'cloudflared']);

    const destDir = path.join(workDir, 'bin');
    await fs.mkdir(destDir, { recursive: true });
    await extractTgz(tgz, destDir);

    const extracted = path.join(destDir, 'cloudflared');
    // The extracted file exists, matches the original payload, and is NOT a
    // gzip archive — i.e. it would `spawn` instead of ENOEXEC.
    expect((await fs.readFile(extracted, 'utf8'))).toBe(payload);
    expect(await isExecutableBinary(extracted)).toBe(true);
  });

  it('rejects when the archive is not a valid tarball', async () => {
    const bad = path.join(workDir, 'bad.tgz');
    await fs.writeFile(bad, 'not a tarball');
    await expect(extractTgz(bad, workDir)).rejects.toThrow();
  });
});
