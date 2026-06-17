/**
 * `codeam host <subcommand>` — self-hosted execution-plane host commands.
 *
 * Design of record:
 * docs/superpowers/specs/2026-06-17-self-hosted-execution-plane-design.md
 *
 * Today the only subcommand is `enroll`, the convenience wrapper the
 * installer (`enroll.sh`, served by the backend) invokes — though in
 * practice the systemd unit runs `codeam host-agent` directly with
 * `CODEAM_ENROLL_TOKEN` set, and that supervisor redeems on first run.
 * `codeam host enroll --token=<EPHEMERAL>` exists as the explicit,
 * idempotent path: redeem the ephemeral token for the long-lived
 * host-token and seal it 0600 at `~/.codeam/host-agent.json`. Running it
 * a second time is a no-op when an identity is already sealed.
 */

import { loadHostIdentity, redeemEnrollToken, saveHostIdentity } from './host/host-client';

function readTokenFlag(args: string[]): string | undefined {
  const flag = args.find((a) => a.startsWith('--token='));
  if (!flag) return undefined;
  const value = flag.slice('--token='.length).trim();
  return value.length > 0 ? value : undefined;
}

function readLabelFlag(args: string[]): string | undefined {
  const flag = args.find((a) => a.startsWith('--label='));
  if (!flag) return undefined;
  const value = flag.slice('--label='.length).trim();
  return value.length > 0 ? value : undefined;
}

/**
 * `codeam host enroll --token=<EPHEMERAL> [--label=<name>]`.
 *
 * Idempotent: when a host identity is already sealed we report it and do
 * NOT re-redeem (the enroll token is single-use server-side, so a second
 * redeem would fail anyway).
 */
export async function hostEnroll(args: string[]): Promise<void> {
  const existing = loadHostIdentity();
  if (existing) {
    // eslint-disable-next-line no-console
    console.log(
      `  Already enrolled (host ${existing.hostId}). Run \`codeam host-agent\` to connect.`,
    );
    return;
  }

  const token = readTokenFlag(args);
  if (!token) {
    throw new Error(
      'codeam host enroll requires --token=<EPHEMERAL>. Copy the command from the app.',
    );
  }

  const identity = await redeemEnrollToken(token, readLabelFlag(args));
  saveHostIdentity(identity);
  // eslint-disable-next-line no-console
  console.log(
    `  Enrolled host ${identity.hostId}. Sealed credentials to ~/.codeam/host-agent.json (0600).`,
  );
  // eslint-disable-next-line no-console
  console.log('  Run `codeam host-agent` (or let systemd start it) to connect.');
}

/** Router for `codeam host <subcommand>`. */
export async function host(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === 'enroll') {
    await hostEnroll(args.slice(1));
    return;
  }
  throw new Error(
    `Unknown 'codeam host' subcommand: ${sub ?? '(none)'}. Try: codeam host enroll --token=<EPHEMERAL>`,
  );
}
