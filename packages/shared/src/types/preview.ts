/**
 * Preview wire types (PreviewDetection / PreviewStatus / EnvVar).
 *
 * CANONICAL WIRE OWNER: this file (`@codeam/shared`) owns the wire
 * protocol, per the cross-repo rule. The backend repo keeps hand-synced
 * MIRRORS (`codeagent-mobile/packages/shared/src/types/preview.ts` for
 * mobile/landing, `codeagent-mobile/apps/api-v2/src/common/types/preview.ts`
 * for the backend); a drift-check script at
 * `codeagent-mobile/scripts/check-shared-drift` compares them.
 */
export interface PreviewDetection {
  framework: string;
  command: string;
  args: string[];
  port: number;
  ready_pattern: string;
  env?: Record<string, string>;
  setup_commands?: Array<{ cmd: string; args: string[] }>;
  notes?: string;
}

export type PreviewState =
  | 'idle'
  | 'detection_pending'
  | 'detection_ready'
  | 'starting'
  | 'running'
  | 'error';

export type PreviewErrorStage =
  | 'detection'
  | 'spawn'
  | 'tunnel'
  | 'ready_timeout'
  | 'unsupported';

/**
 * Un servicio que el proyecto necesita y que NO pudimos levantarle.
 *
 * `envVar` es la variable que el usuario tendria que rellenar para apuntar a
 * uno propio (`DATABASE_URL`, `REDIS_URL`, …). Es el ultimo recurso: primero
 * se intenta docker compose, luego una compose generada, y para Postgres
 * incluso un motor embebido — esto solo viaja cuando todo eso fallo.
 */
export interface MissingService {
  /** Nombre del motor, para decirlo con palabras: `postgres`, `redis`, … */
  service: string;
  /** La variable de entorno que lo resolveria. */
  envVar: string;
}

export interface PreviewStatus {
  state: PreviewState;
  url?: string;
  framework?: string;
  detection?: PreviewDetection;
  error?: { stage: PreviewErrorStage; message: string };
  /**
   * Servicios que el proyecto pide y no estan sirviendo.
   *
   * Viaja con el error para que la UI pueda ofrecer algo ACCIONABLE en vez de
   * un fallo mudo: la CLI ya sabia que le faltaba una base de datos y cual era
   * su variable, pero ese dato se tiraba a la basura en `start.ts` y el usuario
   * solo veia morir el dev server.
   */
  missingServices?: MissingService[];
}

/**
 * One environment variable as edited from the app and written to the
 * project `.env`. The wire shape for `env_read` (returns EnvVar[]) and
 * `env_write` (accepts EnvVar[]).
 */
export interface EnvVar {
  key: string;
  value: string;
}
