import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  normalizeGuardrailPolicy,
  DEFAULT_GUARDRAIL_POLICY,
  type GuardrailPolicy,
} from '@codeam/shared';

/**
 * Per-session guardrail policy holder. Backed by `~/.codeam/guardrails.json`
 * (written at deploy from the deploy payload; ABSENT ⇒ the default-on policy).
 * Cached in-process — a daemon owns exactly one session — and updated live by
 * the `guardrail_configure` relay handler (write-through so it survives a
 * supervisor restart/resume). The runner + the ACP client read it on demand.
 */

let current: GuardrailPolicy | null = null;

export function guardrailConfigPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.codeam', 'guardrails.json');
}

export function loadGuardrailPolicy(homeDir: string = os.homedir()): GuardrailPolicy {
  try {
    current = normalizeGuardrailPolicy(JSON.parse(fs.readFileSync(guardrailConfigPath(homeDir), 'utf8')));
  } catch {
    current = { ...DEFAULT_GUARDRAIL_POLICY }; // absent / bad JSON → default-on
  }
  return current;
}

export function getGuardrailPolicy(homeDir: string = os.homedir()): GuardrailPolicy {
  return current ?? loadGuardrailPolicy(homeDir);
}

/** Update the live policy (from a `guardrail_configure` write) + persist it. */
export function setGuardrailPolicy(raw: unknown, homeDir: string = os.homedir()): GuardrailPolicy {
  const next = normalizeGuardrailPolicy(raw);
  current = next;
  try {
    const p = guardrailConfigPath(homeDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(next, null, 2));
  } catch {
    /* best-effort persist — the in-memory update still applies this process */
  }
  return next;
}

/** Test seam — drop the process cache so a test can re-load from a fresh file. */
export function _resetGuardrailPolicyCache(): void {
  current = null;
}
