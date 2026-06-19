import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// config.ts resolves the codespace-env path via os.homedir(). ESM module
// namespaces aren't spy-able, so mock the module: keep every real export and
// override homedir() to return the per-test temp home (set via mutable holder).
const homeHolder = { dir: os.tmpdir() };
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => homeHolder.dir };
});

/**
 * loadCodespaceEnv() reads `~/.codeam/codespace-env.json` (resolved via
 * os.homedir()) and seeds the allowed keys into process.env. The codespace
 * serving daemon is spawned via setsid with no shell rc, so this file is how
 * the backend bootstrap's vars reach the daemon's process.env.
 *
 * Strategy: point os.homedir() at a temp dir, write a controlled JSON file,
 * snapshot/restore process.env so assertions don't leak between tests.
 */

const ALLOWED = [
  'PREVIEW_TUNNEL_TOKEN',
  'PREVIEW_TUNNEL_HOSTNAME',
  'HEADROOM_ENABLED',
  'HEADROOM_AGENT',
  'HEADROOM_SAVINGS_INGEST_URL',
] as const;

let tempHome: string;
let envSnapshot: NodeJS.ProcessEnv;

function writeEnvFile(contents: string): void {
  const dir = path.join(tempHome, '.codeam');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'codespace-env.json'), contents, 'utf-8');
}

async function importLoader() {
  const mod = await import('../src/config');
  return mod.loadCodespaceEnv;
}

beforeEach(() => {
  vi.resetModules();
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-csenv-'));
  homeHolder.dir = tempHome;
  // Snapshot so each test starts from a clean slate for the allowed keys.
  envSnapshot = { ...process.env };
  for (const k of ALLOWED) delete process.env[k];
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = envSnapshot;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('loadCodespaceEnv', () => {
  it('loads all allowed keys from the file into process.env', async () => {
    writeEnvFile(
      JSON.stringify({
        PREVIEW_TUNNEL_TOKEN: 'tok-123',
        PREVIEW_TUNNEL_HOSTNAME: 'preview.example.com',
        HEADROOM_ENABLED: '1',
        HEADROOM_AGENT: 'claude',
        HEADROOM_SAVINGS_INGEST_URL: 'https://api.example.com/ingest',
      }),
    );
    const loadCodespaceEnv = await importLoader();
    loadCodespaceEnv();

    expect(process.env.PREVIEW_TUNNEL_TOKEN).toBe('tok-123');
    expect(process.env.PREVIEW_TUNNEL_HOSTNAME).toBe('preview.example.com');
    expect(process.env.HEADROOM_ENABLED).toBe('1');
    expect(process.env.HEADROOM_AGENT).toBe('claude');
    expect(process.env.HEADROOM_SAVINGS_INGEST_URL).toBe('https://api.example.com/ingest');
  });

  it('does NOT overwrite an env var that is already set (env wins over file)', async () => {
    process.env.HEADROOM_ENABLED = '0'; // explicit existing value
    writeEnvFile(JSON.stringify({ HEADROOM_ENABLED: '1', HEADROOM_AGENT: 'codex' }));
    const loadCodespaceEnv = await importLoader();
    loadCodespaceEnv();

    expect(process.env.HEADROOM_ENABLED).toBe('0'); // preserved, not clobbered
    expect(process.env.HEADROOM_AGENT).toBe('codex'); // unset key still filled
  });

  it('is a no-op when the file is absent (local / self-hosted)', async () => {
    // No file written.
    const loadCodespaceEnv = await importLoader();
    expect(() => loadCodespaceEnv()).not.toThrow();
    for (const k of ALLOWED) expect(process.env[k]).toBeUndefined();
  });

  it('is a no-op on malformed JSON', async () => {
    writeEnvFile('{ this is not valid json');
    const loadCodespaceEnv = await importLoader();
    expect(() => loadCodespaceEnv()).not.toThrow();
    for (const k of ALLOWED) expect(process.env[k]).toBeUndefined();
  });

  it('ignores unknown keys and non-string / empty-string values', async () => {
    writeEnvFile(
      JSON.stringify({
        PREVIEW_TUNNEL_TOKEN: 'tok-ok',
        HEADROOM_ENABLED: 1, // number, not string → ignored
        HEADROOM_AGENT: '', // empty string → ignored
        SOME_UNKNOWN_KEY: 'should-not-land', // not allow-listed → ignored
      }),
    );
    const loadCodespaceEnv = await importLoader();
    loadCodespaceEnv();

    expect(process.env.PREVIEW_TUNNEL_TOKEN).toBe('tok-ok');
    expect(process.env.HEADROOM_ENABLED).toBeUndefined();
    expect(process.env.HEADROOM_AGENT).toBeUndefined();
    expect(process.env.SOME_UNKNOWN_KEY).toBeUndefined();
  });
});
