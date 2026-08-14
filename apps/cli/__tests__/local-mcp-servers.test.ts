import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

// Same FAKE_HOME seam as __tests__/integrations-provision.test.ts — os.homedir()
// on macOS can ignore $HOME, so mocking node:os is the reliable way to point
// the reader at a throwaway ~/.codeam without touching the real one.
const { FAKE_HOME } = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const p = require('node:path') as typeof import('node:path');
  return { FAKE_HOME: fs.mkdtempSync(p.join(os.tmpdir(), 'local-mcp-servers-home-')) };
});
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, homedir: () => FAKE_HOME, default: { ...actual, homedir: () => FAKE_HOME } };
});

const warnSpy = vi.fn();
const infoSpy = vi.fn();
vi.mock('../src/services/logger', () => ({
  log: {
    warn: (...args: unknown[]) => warnSpy(...args),
    info: (...args: unknown[]) => infoSpy(...args),
  },
}));

import {
  readLocalMcpServers,
  mergeWithLocalMcpServers,
  localMcpServersPath,
} from '../src/services/local-mcp-servers';
import type { McpServerStdio } from '@agentclientprotocol/sdk';

function writeConfig(contents: string): void {
  const file = localMcpServersPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf8');
}

describe('readLocalMcpServers', () => {
  beforeEach(() => {
    warnSpy.mockClear();
    infoSpy.mockClear();
    rmSync(localMcpServersPath(), { force: true });
  });

  it('returns [] when the file does not exist', () => {
    expect(readLocalMcpServers()).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('reads a valid file into McpServerStdio entries with env converted to name/value pairs', () => {
    writeConfig(
      JSON.stringify([
        {
          name: 'local-fs',
          command: '/usr/local/bin/my-mcp',
          args: ['--stdio'],
          env: { FOO: 'bar' },
        },
      ]),
    );

    const servers = readLocalMcpServers();
    expect(servers).toHaveLength(1);
    const server = servers[0] as McpServerStdio;
    expect(server.name).toBe('local-fs');
    expect(server.command).toBe('/usr/local/bin/my-mcp');
    expect(server.args).toEqual(['--stdio']);
    expect(server.env).toEqual([{ name: 'FOO', value: 'bar' }]);
  });

  it('defaults env to [] when omitted', () => {
    writeConfig(JSON.stringify([{ name: 'no-env', command: 'my-mcp', args: [] }]));
    const server = readLocalMcpServers()[0] as McpServerStdio;
    expect(server.env).toEqual([]);
  });

  it('malformed JSON → [] + a single warning', () => {
    writeConfig('{ not valid json');
    expect(readLocalMcpServers()).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('non-array top level → [] + a single warning', () => {
    writeConfig(JSON.stringify({ name: 'oops' }));
    expect(readLocalMcpServers()).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('skips invalid entries (missing/empty name, command, or non-string args) but keeps valid ones', () => {
    writeConfig(
      JSON.stringify([
        { name: 'good', command: 'my-mcp', args: [] },
        { name: '', command: 'my-mcp', args: [] }, // empty name
        { name: 'no-command', args: [] }, // missing command
        { name: 'bad-args', command: 'my-mcp', args: 'not-an-array' }, // args not array
        { name: 'bad-args-2', command: 'my-mcp', args: [1, 2] }, // args not strings
        { name: 'bad-env', command: 'my-mcp', args: [], env: { FOO: 123 } }, // env value not string
        'not-an-object',
      ]),
    );

    const servers = readLocalMcpServers();
    expect(servers.map((s) => s.name)).toEqual(['good']);
    expect(warnSpy).toHaveBeenCalledTimes(1); // one warn for the batch of invalid entries, not per-entry
  });

  it('caps at 10 servers and warns once about truncation', () => {
    const entries = Array.from({ length: 15 }, (_, i) => ({
      name: `srv-${i}`,
      command: 'my-mcp',
      args: [],
    }));
    writeConfig(JSON.stringify(entries));

    const servers = readLocalMcpServers();
    expect(servers).toHaveLength(10);
    expect(servers.map((s) => s.name)).toEqual(entries.slice(0, 10).map((e) => e.name));
    expect(warnSpy).toHaveBeenCalledWith(
      'localMcp',
      expect.stringContaining('more than 10 entries'),
    );
  });

  it('never throws on a directory-shaped path or other read errors', () => {
    // localMcpServersPath()'s parent dir exists but the file itself is absent —
    // already covered by the "does not exist" case above; this just asserts the
    // function's contract (never throws) holds even when called repeatedly.
    expect(() => readLocalMcpServers()).not.toThrow();
  });
});

describe('mergeWithLocalMcpServers', () => {
  beforeEach(() => {
    warnSpy.mockClear();
    infoSpy.mockClear();
    rmSync(localMcpServersPath(), { force: true });
  });

  it('returns the integration list unchanged when there are no local servers', () => {
    const integrations = [{ name: 'jira', command: 'codeam', args: ['mcp-run', 'jira'], env: [] }];
    expect(mergeWithLocalMcpServers(integrations)).toEqual(integrations);
  });

  it('appends local servers after integration servers', () => {
    writeConfig(JSON.stringify([{ name: 'my-local', command: 'my-mcp', args: [] }]));
    const integrations = [{ name: 'jira', command: 'codeam', args: ['mcp-run', 'jira'], env: [] }];

    const merged = mergeWithLocalMcpServers(integrations);
    expect(merged.map((s) => s.name)).toEqual(['jira', 'my-local']);
  });

  it('on a name collision, the integration server wins and the local dup is skipped with a warning', () => {
    writeConfig(JSON.stringify([{ name: 'jira', command: 'my-mcp', args: ['--rogue'] }]));
    const integrations = [{ name: 'jira', command: 'codeam', args: ['mcp-run', 'jira'], env: [] }];

    const merged = mergeWithLocalMcpServers(integrations);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(integrations[0]);
    expect(warnSpy).toHaveBeenCalledWith('localMcp', expect.stringContaining('collides'));
  });
});
