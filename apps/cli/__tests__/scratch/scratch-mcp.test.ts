import { describe, expect, it, vi } from 'vitest';
import {
  SCRATCH_IPC_TOKEN_ENV,
  SCRATCH_IPC_URL_ENV,
  SCRATCH_MCP_SERVER_NAME,
  SCRATCH_TOOLS,
  runScratchTool,
  scratchMcpServer,
} from '../../src/commands/scratch-mcp';
import { buildMcpServersForStart } from '../../src/integrations/provision';
import { loadMcpSecrets } from '../../src/integrations/mcp-secrets';

describe('scratch MCP server entry', () => {
  it('is absent when the bridge never bound', () => {
    expect(scratchMcpServer(null)).toBeNull();
  });

  // codeagent-5bew: the claude ACP adapter copies the MCP env onto the agent's
  // argv, so the bridge token must not be in the env at all — only the path of
  // the owner-only secrets file the shim reads at startup.
  it('keeps the bridge token out of argv AND env; the shim resolves it from the secrets file', () => {
    const entry = scratchMcpServer({ url: 'http://127.0.0.1:5555', token: 'secret-token' })!;
    expect(entry.name).toBe(SCRATCH_MCP_SERVER_NAME);
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual([process.argv[1], 'scratch-mcp']);
    expect(JSON.stringify(entry)).not.toContain('secret-token');
    const env: NodeJS.ProcessEnv = Object.fromEntries(entry.env.map((e) => [e.name, e.value]));
    expect(env[SCRATCH_IPC_URL_ENV]).toBe('http://127.0.0.1:5555');
    loadMcpSecrets(env);
    expect(env[SCRATCH_IPC_TOKEN_ENV]).toBe('secret-token');
  });

  it('exposes exactly suggest_save_project, whose description forbids saving by itself', () => {
    expect(SCRATCH_TOOLS.map((t) => t.name)).toEqual(['suggest_save_project']);
    expect(SCRATCH_TOOLS[0].description).toMatch(/start_preview/);
    expect(SCRATCH_TOOLS[0].description).toMatch(/do not push/i);
  });

  it('is injected only for scratch sessions', () => {
    const base = { sessionId: 's', pluginId: 'p', preview: { url: 'http://127.0.0.1:1', token: 't' } };
    expect(buildMcpServersForStart(base).map((s) => s.name)).not.toContain('codeagent_scratch');
    expect(buildMcpServersForStart({ ...base, scratch: true }).map((s) => s.name)).toContain(
      'codeagent_scratch',
    );
  });
});

describe('runScratchTool', () => {
  it('calls the bridge and reports the card was shown', async () => {
    const call = vi.fn(async () => ({ offered: true }));
    await expect(runScratchTool('suggest_save_project', {}, call)).resolves.toEqual({
      text: expect.stringMatching(/save card/i),
      isError: false,
    });
    expect(call).toHaveBeenCalledWith('/scratch/save-offer', 'POST', {}, expect.any(Number));
  });

  it('a refused offer is a tool error', async () => {
    const call = vi.fn(async () => ({ offered: false }));
    const r = await runScratchTool('suggest_save_project', {}, call);
    expect(r.isError).toBe(true);
  });

  it('a bridge failure is a tool error naming the reason', async () => {
    const call = vi.fn(async () => {
      throw new Error('boom');
    });
    const r = await runScratchTool('suggest_save_project', {}, call);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('boom');
  });

  it('an unknown tool is an error', async () => {
    const r = await runScratchTool('nope', {}, vi.fn());
    expect(r.isError).toBe(true);
  });
});
