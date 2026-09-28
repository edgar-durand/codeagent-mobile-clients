import { resolveApiBaseUrl } from '@codeam/shared';
import { log } from '../services/logger';

export interface ScratchCtx {
  sessionId: string;
  pluginId: string;
  pluginAuthToken?: string;
}

async function post(
  ctx: ScratchCtx,
  route: string,
  extra: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  if (!ctx.pluginAuthToken) return false;
  try {
    const res = await fetchImpl(`${resolveApiBaseUrl()}/api/scratch/projects/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Plugin-Auth-Token': ctx.pluginAuthToken },
      body: JSON.stringify({ sessionId: ctx.sessionId, pluginId: ctx.pluginId, ...extra }),
      signal: AbortSignal.timeout(8_000),
    });
    return res.ok;
  } catch (err) {
    log.debug('scratch', `${route} failed: ${(err as Error).message}`);
    return false;
  }
}

export async function registerScratchProject(
  ctx: ScratchCtx,
  deployId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await post(ctx, 'register', { deployId }, fetchImpl);
}

export function postScratchOffer(
  ctx: ScratchCtx,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  return post(ctx, 'offer', {}, fetchImpl);
}

export async function postZipDownloaded(
  ctx: ScratchCtx,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await post(ctx, 'zip-downloaded', {}, fetchImpl);
}
