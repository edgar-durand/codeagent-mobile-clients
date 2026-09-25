import { describe, expect, it, vi } from 'vitest';
import {
  PREVIEW_IPC_TOKEN_ENV,
  PREVIEW_IPC_URL_ENV,
  PREVIEW_MCP_SERVER_NAME,
  PREVIEW_TOOLS,
  previewMcpServer,
  runPreviewTool,
} from '../../src/commands/preview-mcp';
import { loadMcpSecrets } from '../../src/integrations/mcp-secrets';

describe('preview MCP server entry', () => {
  it('is absent when the bridge never bound', () => {
    expect(previewMcpServer(null)).toBeNull();
  });

  // codeagent-5bew: the claude ACP adapter copies the MCP env onto the agent's
  // argv, so the bridge token must not be in the env at all — only the path of
  // the owner-only secrets file the shim reads at startup.
  it('keeps the bridge token out of argv AND env; the shim resolves it from the secrets file', () => {
    const entry = previewMcpServer({ url: 'http://127.0.0.1:5555', token: 'secret-token' })!;
    expect(entry.name).toBe(PREVIEW_MCP_SERVER_NAME);
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual([process.argv[1], 'preview-mcp']);
    expect(JSON.stringify(entry)).not.toContain('secret-token');
    const env: NodeJS.ProcessEnv = Object.fromEntries(entry.env.map((e) => [e.name, e.value]));
    expect(env[PREVIEW_IPC_URL_ENV]).toBe('http://127.0.0.1:5555');
    loadMcpSecrets(env);
    expect(env[PREVIEW_IPC_TOKEN_ENV]).toBe('secret-token');
  });

  it('exposes exactly the five preview tools', () => {
    expect(PREVIEW_TOOLS.map((t) => t.name)).toEqual([
      'start_preview',
      'preview_status',
      'highlight_element',
      'clear_highlights',
      'stop_preview',
    ]);
  });
});

describe('runPreviewTool', () => {
  it('start_preview → POST /preview/start and a sentence with the URL', async () => {
    const call = vi.fn().mockResolvedValue({
      status: 'running',
      url: 'https://x.preview.codeagent-mobile.com',
      framework: 'next',
      inspector: true,
    });
    const r = await runPreviewTool('start_preview', {}, call);
    expect(call).toHaveBeenCalledWith('/preview/start', 'POST', {}, expect.any(Number));
    expect(r.isError).toBe(false);
    expect(r.text).toContain('https://x.preview.codeagent-mobile.com');
    expect(r.text).toContain('highlight_element');
  });

  it('a pipeline error comes back as a tool error with its stage', async () => {
    const call = vi.fn().mockResolvedValue({ status: 'error', stage: 'spawn', message: 'EADDRINUSE' });
    const r = await runPreviewTool('start_preview', {}, call);
    expect(r).toEqual({ text: 'Preview failed at spawn: EADDRINUSE', isError: true });
  });

  it('clear_highlights posts {clear:true} to the highlight route', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, message: 'Cleared' });
    const r = await runPreviewTool('clear_highlights', {}, call);
    expect(call).toHaveBeenCalledWith('/preview/highlight', 'POST', { clear: true }, expect.any(Number));
    expect(r.isError).toBe(false);
  });

  it('a refused highlight is a tool error', async () => {
    const call = vi.fn().mockResolvedValue({ ok: false, message: 'No preview is running' });
    const r = await runPreviewTool('highlight_element', { selector: '#a' }, call);
    expect(r).toEqual({ text: 'No preview is running', isError: true });
  });

  it('an unknown tool is an error', async () => {
    const r = await runPreviewTool('nope', {}, vi.fn());
    expect(r.isError).toBe(true);
  });
});
