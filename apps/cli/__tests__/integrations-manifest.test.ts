import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// Point the manifest's data root (`os.homedir()/.codeam`) at a throwaway dir
// so the store functions can be exercised without touching a real ~/.codeam.
// `os.homedir()` on macOS can ignore `$HOME`, so mocking `node:os` is the
// reliable seam (mirrors `__tests__/agents/cursor.bridge.test.ts`).
const { FAKE_HOME } = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const p = require('node:path') as typeof import('node:path');
  return { FAKE_HOME: fs.mkdtempSync(p.join(os.tmpdir(), 'integrations-home-')) };
});
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, homedir: () => FAKE_HOME, default: { ...actual, homedir: () => FAKE_HOME } };
});

import {
  integrationsManifestPath,
  readIntegrationsManifest,
  persistIntegrationsManifest,
  clearIntegrationsManifest,
} from '../src/integrations/manifest';
import type { IntegrationsManifest } from '@codeam/shared';

const SAMPLE: IntegrationsManifest = {
  integrations: [
    {
      id: 'jira',
      delivery: {
        mcp: {
          command: 'codeam',
          args: ['mcp-run', 'jira'],
          envMapping: { JIRA_ACCESS_TOKEN: 'accessToken' },
        },
      },
    },
  ],
};

describe('integrations manifest store', () => {
  beforeEach(() => {
    clearIntegrationsManifest();
  });

  it('integrationsManifestPath() resolves under the (mocked) home dir', () => {
    expect(integrationsManifestPath()).toBe(path.join(FAKE_HOME, '.codeam', 'integrations.json'));
  });

  it('persists atomically and round-trips an equal manifest', () => {
    persistIntegrationsManifest(SAMPLE);

    const file = integrationsManifestPath();
    expect(existsSync(file)).toBe(true);
    // No leftover temp file from the atomic write.
    expect(existsSync(`${file}.tmp-${process.pid}`)).toBe(false);

    const readBack = readIntegrationsManifest();
    expect(readBack).toEqual(SAMPLE);
  });

  it('writes the file 0600 on POSIX', () => {
    if (process.platform === 'win32') return; // POSIX-only assertion
    persistIntegrationsManifest(SAMPLE);
    const mode = statSync(integrationsManifestPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('readIntegrationsManifest() returns null when the file is missing', () => {
    expect(readIntegrationsManifest()).toBeNull();
  });

  it('readIntegrationsManifest() returns null on invalid JSON', () => {
    const file = integrationsManifestPath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{ not valid json', 'utf8');
    expect(readIntegrationsManifest()).toBeNull();
  });

  it('readIntegrationsManifest() returns null when integrations is not an array', () => {
    const file = integrationsManifestPath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ integrations: 'nope' }), 'utf8');
    expect(readIntegrationsManifest()).toBeNull();
  });

  it('clearIntegrationsManifest() removes the file', () => {
    persistIntegrationsManifest(SAMPLE);
    expect(existsSync(integrationsManifestPath())).toBe(true);

    clearIntegrationsManifest();
    expect(existsSync(integrationsManifestPath())).toBe(false);
  });

  it('clearIntegrationsManifest() is a no-op (does not throw) when the file is already absent', () => {
    expect(() => clearIntegrationsManifest()).not.toThrow();
  });
});
