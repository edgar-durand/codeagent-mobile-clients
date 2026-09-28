import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteCommand, CommandRelayService } from '../../src/services/command-relay.service';

vi.mock('../../src/scratch/export-files', () => ({
  listExportFiles: vi.fn(),
  topPaths: vi.fn(),
}));
vi.mock('../../src/scratch/zip', () => ({
  buildZip: vi.fn(),
}));
vi.mock('../../src/scratch/export-registry', () => ({
  registerExport: vi.fn(),
  exportDir: vi.fn(),
  EXPORT_PATH_PREFIX: '/.codeam/export/',
}));
vi.mock('../../src/scratch/export-tunnel', () => ({
  ensureExportBaseUrl: vi.fn(),
}));
vi.mock('../../src/scratch/api', () => ({
  postZipDownloaded: vi.fn(),
}));
vi.mock('../../src/scratch/save-github', () => ({
  saveToGithub: vi.fn(),
}));
vi.mock('../../src/scratch/workspace', () => ({
  isScratchWorkspace: vi.fn(),
}));
vi.mock('../../src/services/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

import { scratchExportZipH, scratchSaveGithubH, type ScratchHandlerCtx } from '../../src/scratch/handlers';
import { listExportFiles, topPaths } from '../../src/scratch/export-files';
import { buildZip } from '../../src/scratch/zip';
import { registerExport, exportDir } from '../../src/scratch/export-registry';
import { ensureExportBaseUrl } from '../../src/scratch/export-tunnel';
import { postZipDownloaded } from '../../src/scratch/api';
import { saveToGithub } from '../../src/scratch/save-github';
import { isScratchWorkspace } from '../../src/scratch/workspace';
import { log } from '../../src/services/logger';

const opts = { sessionId: 's1', pluginId: 'p1', pluginAuthToken: 'tok' };

function makeCmd(type: string, payload: Record<string, unknown>): RemoteCommand {
  return { id: 'cmd1', sessionId: 's1', type, payload };
}

function makeRelay(): { sendResult: ReturnType<typeof vi.fn> } & CommandRelayService {
  return { sendResult: vi.fn().mockResolvedValue(undefined) } as unknown as {
    sendResult: ReturnType<typeof vi.fn>;
  } & CommandRelayService;
}

const tmpDirs: string[] = [];
function makeTmpExportDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-handlers-test-'));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isScratchWorkspace).mockReturnValue(true);
});

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('scratchExportZipH', () => {
  it('over the limit answers tooLarge with topPaths and writes nothing', async () => {
    const files = [{ rel: 'big/file.bin', bytes: 190_000_000 }];
    vi.mocked(listExportFiles).mockResolvedValue({ files, totalBytes: 200 * 1024 * 1024, envExample: null });
    vi.mocked(topPaths).mockReturnValue([{ path: 'big/', bytes: 190_000_000 }]);
    const tmpExportDir = path.join(os.tmpdir(), `codeam-handlers-unused-${Date.now()}`);
    vi.mocked(exportDir).mockReturnValue(tmpExportDir);
    const relay = makeRelay();
    const ctx: ScratchHandlerCtx = {
      cmd: makeCmd('scratch_export_zip', { limitBytes: 100 * 1024 * 1024 }),
      relay,
      opts,
    };

    await scratchExportZipH(ctx);

    expect(relay.sendResult).toHaveBeenCalledTimes(1);
    expect(relay.sendResult).toHaveBeenCalledWith('cmd1', 'completed', {
      tooLarge: true,
      sizeBytes: 200 * 1024 * 1024,
      limitBytes: 100 * 1024 * 1024,
      topPaths: [{ path: 'big/', bytes: 190_000_000 }],
    });
    expect(buildZip).not.toHaveBeenCalled();
    expect(registerExport).not.toHaveBeenCalled();
    // The handler never created the export dir for a request it rejected up front.
    expect(fs.existsSync(tmpExportDir)).toBe(false);
  });

  it('under the limit builds, registers, and answers {url,sizeBytes,expiresAt}; completion posts zip-downloaded and releases the tunnel hold', async () => {
    const list = { files: [{ rel: 'a.ts', bytes: 10 }], totalBytes: 10, envExample: null };
    vi.mocked(listExportFiles).mockResolvedValue(list);
    vi.mocked(buildZip).mockResolvedValue(12345);
    const tmpExportDir = makeTmpExportDir();
    vi.mocked(exportDir).mockReturnValue(tmpExportDir);
    const expiresAt = new Date(Date.now() + 600_000);
    let capturedOnComplete: (() => void) | undefined;
    vi.mocked(registerExport).mockImplementation((_file, _size, onComplete) => {
      capturedOnComplete = onComplete;
      return { token: 'a'.repeat(48), expiresAt };
    });
    const release = vi.fn();
    vi.mocked(ensureExportBaseUrl).mockResolvedValue({
      baseUrl: 'https://preview-x.codeagent-mobile.com',
      release,
    });
    const relay = makeRelay();
    const ctx: ScratchHandlerCtx = {
      cmd: makeCmd('scratch_export_zip', { limitBytes: 100 * 1024 * 1024 }),
      relay,
      opts,
    };

    await scratchExportZipH(ctx);

    expect(relay.sendResult).toHaveBeenCalledTimes(1);
    const [id, status, result] = relay.sendResult.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(id).toBe('cmd1');
    expect(status).toBe('completed');
    expect(result.url).toMatch(/^https:\/\/preview-x\.codeagent-mobile\.com\/\.codeam\/export\/[0-9a-f]{48}$/);
    expect(result.sizeBytes).toBe(12345);
    expect(result.expiresAt).toBe(expiresAt.toISOString());

    expect(capturedOnComplete).toBeTypeOf('function');
    expect(postZipDownloaded).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    capturedOnComplete!();
    expect(postZipDownloaded).toHaveBeenCalledWith(opts);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('limitBytes null (PRO) never reports tooLarge', async () => {
    vi.mocked(listExportFiles).mockResolvedValue({ files: [], totalBytes: 500 * 1024 * 1024, envExample: null });
    vi.mocked(buildZip).mockResolvedValue(500 * 1024 * 1024);
    vi.mocked(exportDir).mockReturnValue(makeTmpExportDir());
    vi.mocked(registerExport).mockReturnValue({ token: 'b'.repeat(48), expiresAt: new Date() });
    vi.mocked(ensureExportBaseUrl).mockResolvedValue({
      baseUrl: 'https://preview-y.codeagent-mobile.com',
      release: vi.fn(),
    });
    const relay = makeRelay();
    const ctx: ScratchHandlerCtx = {
      cmd: makeCmd('scratch_export_zip', { limitBytes: null }),
      relay,
      opts,
    };

    await scratchExportZipH(ctx);

    expect(buildZip).toHaveBeenCalled();
    const [, status, result] = relay.sendResult.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(status).toBe('completed');
    expect(result).not.toHaveProperty('tooLarge');
    expect(topPaths).not.toHaveBeenCalled();
  });

  it('EXPORT_TUNNEL_UNAVAILABLE → failed with a user-safe error and the zip deleted', async () => {
    vi.mocked(listExportFiles).mockResolvedValue({
      files: [{ rel: 'a.ts', bytes: 10 }],
      totalBytes: 10,
      envExample: null,
    });
    vi.mocked(buildZip).mockImplementation(async (_cwd, _list, outFile) => {
      fs.writeFileSync(outFile, 'zip-bytes');
      return 9;
    });
    const tmpExportDir = makeTmpExportDir();
    vi.mocked(exportDir).mockReturnValue(tmpExportDir);
    vi.mocked(registerExport).mockReturnValue({ token: 'c'.repeat(48), expiresAt: new Date() });
    vi.mocked(ensureExportBaseUrl).mockRejectedValue(new Error('EXPORT_TUNNEL_UNAVAILABLE'));
    const relay = makeRelay();
    const ctx: ScratchHandlerCtx = {
      cmd: makeCmd('scratch_export_zip', { limitBytes: null }),
      relay,
      opts,
    };

    await scratchExportZipH(ctx);

    expect(relay.sendResult).toHaveBeenCalledTimes(1);
    expect(relay.sendResult).toHaveBeenCalledWith('cmd1', 'failed', {
      error: "Couldn't prepare the download — try again.",
    });
    expect(fs.readdirSync(tmpExportDir)).toEqual([]);
    // Registered only once the tunnel is up: no dangling registry entry.
    expect(registerExport).not.toHaveBeenCalled();
  });

  it('a cwd that is not a git repo answers failed with a user-safe error', async () => {
    vi.mocked(listExportFiles).mockRejectedValue(
      new Error(
        'Command failed: git -C /x ls-files -co --exclude-standard -z\nfatal: not a git repository (or any of the parent directories): .git\n',
      ),
    );
    const relay = makeRelay();
    const ctx: ScratchHandlerCtx = {
      cmd: makeCmd('scratch_export_zip', { limitBytes: null }),
      relay,
      opts,
    };

    await scratchExportZipH(ctx);

    expect(relay.sendResult).toHaveBeenCalledTimes(1);
    expect(relay.sendResult).toHaveBeenCalledWith('cmd1', 'failed', {
      error: "This session's folder isn't a git project, so it can't be exported.",
    });
    expect(buildZip).not.toHaveBeenCalled();
    expect(registerExport).not.toHaveBeenCalled();
  });

  it('a generic build failure answers a user-safe message and only LOGS the detail', async () => {
    vi.mocked(listExportFiles).mockRejectedValue(
      new Error('Command failed: git -C /home/box/secret-path ls-files\nENOSPC: no space left on device'),
    );
    const relay = makeRelay();
    const ctx: ScratchHandlerCtx = {
      cmd: makeCmd('scratch_export_zip', { limitBytes: null }),
      relay,
      opts,
    };

    await scratchExportZipH(ctx);

    expect(relay.sendResult).toHaveBeenCalledTimes(1);
    expect(relay.sendResult).toHaveBeenCalledWith('cmd1', 'failed', {
      error: "Couldn't build the ZIP — try again.",
    });
    expect(JSON.stringify(relay.sendResult.mock.calls)).not.toContain('/home/box');
    expect(log.warn).toHaveBeenCalledWith('scratch', expect.stringContaining('ENOSPC'));
  });
});

describe('scratchSaveGithubH', () => {
  it('a NON-scratch session fails SAVE_FAILED without touching git', async () => {
    vi.mocked(isScratchWorkspace).mockReturnValue(false);
    const relay = makeRelay();
    const ctx: ScratchHandlerCtx = {
      cmd: makeCmd('scratch_save_github', { repoName: 'landing', private: true, token: 'gho_x' }),
      relay,
      opts,
    };

    await scratchSaveGithubH(ctx);

    expect(isScratchWorkspace).toHaveBeenCalledWith(process.cwd());
    expect(saveToGithub).not.toHaveBeenCalled();
    expect(relay.sendResult).toHaveBeenCalledTimes(1);
    expect(relay.sendResult).toHaveBeenCalledWith('cmd1', 'failed', {
      code: 'SAVE_FAILED',
      error: 'Save to GitHub is only available for projects started from scratch.',
    });
  });

  it('completes with repoFullName and htmlUrl on success', async () => {
    vi.mocked(saveToGithub).mockResolvedValue({
      repoFullName: 'me/landing',
      htmlUrl: 'https://github.com/me/landing',
    });
    const relay = makeRelay();
    const ctx: ScratchHandlerCtx = {
      cmd: makeCmd('scratch_save_github', { repoName: 'landing', private: false, token: 'gho_x' }),
      relay,
      opts,
    };

    await scratchSaveGithubH(ctx);

    expect(saveToGithub).toHaveBeenCalledWith(process.cwd(), {
      repoName: 'landing',
      private: false,
      token: 'gho_x',
    });
    expect(relay.sendResult).toHaveBeenCalledTimes(1);
    expect(relay.sendResult).toHaveBeenCalledWith('cmd1', 'completed', {
      repoFullName: 'me/landing',
      htmlUrl: 'https://github.com/me/landing',
    });
  });

  it('defaults private to true when omitted', async () => {
    vi.mocked(saveToGithub).mockResolvedValue({ repoFullName: 'me/x', htmlUrl: 'https://github.com/me/x' });
    const relay = makeRelay();
    const ctx: ScratchHandlerCtx = {
      cmd: makeCmd('scratch_save_github', { repoName: 'x', token: 'gho_x' }),
      relay,
      opts,
    };

    await scratchSaveGithubH(ctx);

    expect(saveToGithub).toHaveBeenCalledWith(process.cwd(), {
      repoName: 'x',
      private: true,
      token: 'gho_x',
    });
  });

  it('maps REPO_NAME_TAKEN to failed {code}', async () => {
    vi.mocked(saveToGithub).mockRejectedValue(
      Object.assign(new Error('A repository with that name already exists.'), { code: 'REPO_NAME_TAKEN' }),
    );
    const relay = makeRelay();
    const ctx: ScratchHandlerCtx = {
      cmd: makeCmd('scratch_save_github', { repoName: 'landing', private: true, token: 'gho_secret' }),
      relay,
      opts,
    };

    await scratchSaveGithubH(ctx);

    expect(relay.sendResult).toHaveBeenCalledTimes(1);
    expect(relay.sendResult).toHaveBeenCalledWith('cmd1', 'failed', {
      code: 'REPO_NAME_TAKEN',
      error: 'A repository with that name already exists.',
    });
  });

  it('maps a non-REPO_NAME_TAKEN failure to SAVE_FAILED', async () => {
    vi.mocked(saveToGithub).mockRejectedValue(Object.assign(new Error('Push failed: fatal'), { code: 'SAVE_FAILED' }));
    const relay = makeRelay();
    const ctx: ScratchHandlerCtx = {
      cmd: makeCmd('scratch_save_github', { repoName: 'landing', private: true, token: 'gho_secret' }),
      relay,
      opts,
    };

    await scratchSaveGithubH(ctx);

    expect(relay.sendResult).toHaveBeenCalledWith('cmd1', 'failed', {
      code: 'SAVE_FAILED',
      error: 'Push failed: fatal',
    });
  });

  it('missing repoName or token fails immediately with SAVE_FAILED, without calling saveToGithub', async () => {
    const relay = makeRelay();
    const ctx: ScratchHandlerCtx = {
      cmd: makeCmd('scratch_save_github', { private: true }),
      relay,
      opts,
    };

    await scratchSaveGithubH(ctx);

    expect(saveToGithub).not.toHaveBeenCalled();
    expect(relay.sendResult).toHaveBeenCalledTimes(1);
    expect(relay.sendResult).toHaveBeenCalledWith('cmd1', 'failed', {
      code: 'SAVE_FAILED',
      error: 'Missing repo name or token.',
    });
  });
});

describe('both ack exactly once', () => {
  it('scratch_export_zip and scratch_save_github each call relay.sendResult exactly once', async () => {
    vi.mocked(listExportFiles).mockResolvedValue({ files: [], totalBytes: 0, envExample: null });
    vi.mocked(buildZip).mockResolvedValue(0);
    vi.mocked(exportDir).mockReturnValue(makeTmpExportDir());
    vi.mocked(registerExport).mockReturnValue({ token: 'd'.repeat(48), expiresAt: new Date() });
    vi.mocked(ensureExportBaseUrl).mockResolvedValue({ baseUrl: 'https://x.codeagent-mobile.com', release: vi.fn() });
    const exportRelay = makeRelay();
    await scratchExportZipH({
      cmd: makeCmd('scratch_export_zip', { limitBytes: null }),
      relay: exportRelay,
      opts,
    });
    expect(exportRelay.sendResult).toHaveBeenCalledTimes(1);

    vi.mocked(saveToGithub).mockResolvedValue({ repoFullName: 'me/x', htmlUrl: 'https://github.com/me/x' });
    const saveRelay = makeRelay();
    await scratchSaveGithubH({
      cmd: makeCmd('scratch_save_github', { repoName: 'x', token: 't' }),
      relay: saveRelay,
      opts,
    });
    expect(saveRelay.sendResult).toHaveBeenCalledTimes(1);
  });
});
