/**
 * Mirror of `@windsurf/shared`'s PreviewDetection / PreviewStatus.
 * Kept byte-for-byte in sync with the canonical source in the private
 * repo's `packages/shared/src/types/preview.ts` so the CLI can consume
 * the same shapes the backend + mobile + landing speak.
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
