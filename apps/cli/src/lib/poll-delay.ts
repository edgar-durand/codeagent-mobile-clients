export interface PollDelayParams {
  baseMs: number;
  failures: number;
}

const MAX_DELAY_MS = 30_000;

export function computePollDelay({ baseMs, failures }: PollDelayParams): number {
  const exp = Math.min(MAX_DELAY_MS, baseMs * Math.pow(2, failures));
  const jitter = exp * (0.9 + Math.random() * 0.2); // ±10%
  return Math.round(jitter);
}
