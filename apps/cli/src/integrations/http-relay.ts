// src/integrations/http-relay.ts
//
// HTTP-transport delivery for `codeam mcp-run <id>`. Some vendors ship ONLY a
// hosted MCP over Streamable HTTP (e.g. PostHog `mcp.posthog.com`) with a
// header-based token — their stdio bridges (mcp-remote) force an interactive
// browser OAuth that our headless broker can't drive. So instead of spawning a
// stdio child, the shim becomes a thin, method-agnostic RELAY: it exposes an
// stdio MCP server to the agent and forwards every JSON-RPC message to the
// remote MCP over Streamable HTTP, with the brokered credential injected as a
// header (never on argv, never in the agent's env).
import { IntegrationTokenClient } from './token-client';
import type { BrokeredIntegrationToken, IntegrationMcpDelivery } from '@codeam/shared';

/** Fill `{field}` placeholders in a template from the brokered token (e.g.
 *  `Bearer {accessToken}` → `Bearer phx_…`, or `mcp.{host}` → `mcp.datadoghq.com`).
 *  A missing field → empty. */
export function fillTemplate(template: string, token: BrokeredIntegrationToken): string {
  return template.replace(/\{(\w+)\}/g, (_m, field: string) => {
    const v = token[field as keyof BrokeredIntegrationToken];
    return typeof v === 'string' ? v : '';
  });
}

/** Fill `{field}` placeholders in each header template from the brokered token. */
export function buildHttpHeaders(
  httpHeaders: Record<string, string> | undefined,
  token: BrokeredIntegrationToken,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(httpHeaders ?? {})) {
    headers[name] = fillTemplate(template, token);
  }
  return headers;
}

/**
 * Relay the agent's stdio MCP to the remote HTTP MCP for the lifetime of the
 * session. Resolves when either side closes (agent disconnects or the remote
 * drops), which lets the shim process exit cleanly.
 */
export async function runHttpRelay(
  delivery: IntegrationMcpDelivery,
  client: IntegrationTokenClient,
  id: string,
): Promise<void> {
  if (!delivery.httpUrl) throw new Error('runHttpRelay called without delivery.httpUrl');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  );

  const token = await client.getToken(id);
  // `httpUrl` may template a per-user field (e.g. Datadog's regional site
  // `https://mcp.{host}/…`); headers template the credential(s).
  const url = new URL(fillTemplate(delivery.httpUrl, token));
  const httpTransport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: buildHttpHeaders(delivery.httpHeaders, token) },
  });
  const stdioTransport = new StdioServerTransport();

  await new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      void httpTransport.close().catch(() => undefined);
      void stdioTransport.close().catch(() => undefined);
      if (err) reject(err);
      else resolve();
    };

    // Method-agnostic byte-level relay: whatever one side emits, forward verbatim.
    stdioTransport.onmessage = (msg) => {
      void httpTransport.send(msg).catch((e) => {
        process.stderr.write(`[mcp-run http] send→remote failed: ${String(e)}\n`);
      });
    };
    httpTransport.onmessage = (msg) => {
      void stdioTransport.send(msg).catch(() => undefined);
    };
    stdioTransport.onclose = () => finish();
    httpTransport.onclose = () => finish();
    stdioTransport.onerror = (e) => process.stderr.write(`[mcp-run http] stdio: ${String(e)}\n`);
    httpTransport.onerror = (e) => process.stderr.write(`[mcp-run http] http: ${String(e)}\n`);

    Promise.all([httpTransport.start(), stdioTransport.start()]).catch((e) =>
      finish(e instanceof Error ? e : new Error(String(e))),
    );
  });
}
