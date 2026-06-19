import { execFile } from 'node:child_process';

export interface LaunchSpec {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Rewrite a launch to run under Headroom's local compression proxy
 * (`headroom wrap <agent> -- <original args>`). Returns the launch UNCHANGED
 * when Headroom is disabled or not installed — the never-break guarantee:
 * a missing/broken Headroom must never stop the agent from launching.
 */
export function wrapWithHeadroom(
  launch: LaunchSpec,
  opts: { enabled: boolean; agent: string; headroomPresent: boolean },
): LaunchSpec {
  if (!opts.enabled || !opts.headroomPresent) return launch;
  return {
    cmd: 'headroom',
    args: ['wrap', opts.agent, '--', ...launch.args],
    env: launch.env,
  };
}

/** True if `headroom --version` resolves. Cached per process. */
let _present: boolean | undefined;
export function headroomPresent(): Promise<boolean> {
  if (_present !== undefined) return Promise.resolve(_present);
  return new Promise((resolve) => {
    execFile('headroom', ['--version'], (err) => { _present = !err; resolve(_present!); });
  });
}
