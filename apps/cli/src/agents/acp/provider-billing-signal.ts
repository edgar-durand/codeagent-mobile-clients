import { log } from '../../services/logger';
import { capture } from '../../services/telemetry.service';
import { classifyProviderBilling, type ProviderBillingMarker } from '../../lib/provider-routing';

/**
 * Structured provider-billing marker for the debug log + telemetry
 * (codeagent-tvqt). When an agent output line reads like a provider 402
 * (`API Error: 402 Insufficient credits`, `insufficient balance`) this writes
 * ONE grep-able line per (marker, source) into `~/.codeam/debug-<pid>.log`:
 *
 *   [codeam:warn] providerBilling — {"marker":"provider_billing_external",
 *     "source":"reply","agent":"claude","anthropicHost":"default","snippet":"…"}
 *
 * and captures the same shape as a typed PostHog event (the CLI's existing
 * telemetry channel — no new backend endpoint). `provider_billing_external`
 * means the host in effect is NOT our proxy: the user's own provider account
 * is out of credit, nothing on our side to fix. `provider_billing_house` is
 * ours to investigate.
 *
 * Deduped per process per (marker, source) so a retry loop can't spam.
 * Never throws — it sits on the turn/stderr paths.
 */
const seen = new Set<string>();

export type ProviderBillingSource = 'reply' | 'stderr';

export function noteProviderBillingSignal(opts: {
  text: string;
  source: ProviderBillingSource;
  agent: string;
  env?: NodeJS.ProcessEnv;
}): ProviderBillingMarker | null {
  try {
    if (!opts.text) return null;
    const marker = classifyProviderBilling(opts.text, opts.env ?? process.env);
    if (!marker) return null;
    const key = `${marker.marker}:${opts.source}`;
    if (seen.has(key)) return marker;
    seen.add(key);
    const record = {
      marker: marker.marker,
      source: opts.source,
      agent: opts.agent,
      anthropicHost: marker.anthropicHost,
      snippet: marker.snippet,
    };
    log.warn('providerBilling', JSON.stringify(record));
    capture(marker.marker, {
      source: opts.source,
      agent: opts.agent,
      anthropic_host: marker.anthropicHost,
    });
    return marker;
  } catch {
    return null;
  }
}

/** Test-only: forget the per-process dedupe. */
export function _resetProviderBillingSignalForTests(): void {
  seen.clear();
}
