import { startInspectorProxy, type InspectorProxy } from './inspector-proxy';
import { inspectorClientSource } from './inspector-client';

/**
 * Decide si el inspector se levanta, y lo levanta — o se aparta.
 *
 * ⚠️ **Aquí vive la invariante «transparente o ausente».** Todo lo que puede
 * salir mal al meter un proceso nuestro delante del dev server de alguien se
 * resuelve en un solo sitio: si el proxy no arranca, se devuelve `null`, el
 * túnel recibe el puerto del dev server y estamos EXACTAMENTE en el código de
 * antes de que este fichero existiera. El preview nunca falla por culpa del
 * inspector.
 *
 * Por eso el arranque se inyecta (`deps.start`): la prueba que importa no es
 * «el proxy funciona» —eso lo cubren sus tests de integración— sino «cuando el
 * proxy NO funciona, el preview sigue».
 */

/** Los orígenes del dashboard, los únicos que pueden manejar el inspector. */
export const DEFAULT_INSPECTOR_ORIGINS = [
  'https://www.codeagent-mobile.com',
  'https://codeagent-mobile.com',
  'https://dev.codeagent-mobile.com',
];

/**
 * Interruptor de emergencia. Con `CODEAM_PREVIEW_INSPECTOR=0` no se levanta
 * nada y el preview vuelve a su camino de siempre — la salida para un usuario
 * al que el proxy le esté dando guerra, sin esperar a un release.
 */
export function inspectorEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.CODEAM_PREVIEW_INSPECTOR;
  return raw !== '0' && raw !== 'false';
}

/**
 * Los orígenes autorizados, con escotilla por env para desarrollo local
 * (`CODEAM_INSPECTOR_ORIGINS=http://localhost:5173,...`).
 */
export function resolveInspectorOrigins(env: NodeJS.ProcessEnv): string[] {
  const raw = env.CODEAM_INSPECTOR_ORIGINS;
  if (!raw) return DEFAULT_INSPECTOR_ORIGINS;
  const extra = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...DEFAULT_INSPECTOR_ORIGINS, ...extra];
}

export interface BringUpInspectorDeps {
  /** Inyectable para poder probar el camino de fallo sin abrir puertos. */
  start?: typeof startInspectorProxy;
  log?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}

/**
 * El puerto que hay que darle al túnel, y el proxy que habrá que cerrar.
 *
 * `proxy: null` significa «sigue el camino de siempre»: el túnel apunta
 * directo al dev server.
 */
export interface InspectorBringUp {
  port: number;
  proxy: InspectorProxy | null;
}

export async function bringUpInspector(
  targetPort: number,
  deps: BringUpInspectorDeps = {},
): Promise<InspectorBringUp> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? (() => undefined);

  if (!inspectorEnabled(env)) {
    log('preview inspector disabled by CODEAM_PREVIEW_INSPECTOR');
    return { port: targetPort, proxy: null };
  }

  try {
    const start = deps.start ?? startInspectorProxy;
    const proxy = await start({
      targetPort,
      script: inspectorClientSource({ allowedOrigins: resolveInspectorOrigins(env) }),
    });
    log(`preview inspector proxy on :${proxy.port} → :${targetPort}`);
    return { port: proxy.port, proxy };
  } catch (e) {
    // ⚠️ Se traga TODO. Un puerto que no se puede abrir, un límite de
    // descriptores, lo que sea: nada de esto justifica dejar al usuario sin
    // preview. Se registra y se sigue por el camino de siempre.
    log(`preview inspector unavailable (${(e as Error).message}) — going direct`);
    return { port: targetPort, proxy: null };
  }
}
