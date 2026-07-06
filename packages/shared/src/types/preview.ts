/**
 * Preview wire types (PreviewDetection / PreviewStatus / EnvVar).
 *
 * CANONICAL WIRE OWNER: this file (`@codeagent/shared`) owns the wire
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

export interface PreviewStatus {
  state: PreviewState;
  url?: string;
  framework?: string;
  detection?: PreviewDetection;
  error?: { stage: PreviewErrorStage; message: string };
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
