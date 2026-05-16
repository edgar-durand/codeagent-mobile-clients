/**
 * Vercel "Protection Bypass for Automation" header for backend requests.
 *
 * When the CLI runs inside a managed codespace (provisioned via the
 * mobile app's `deploy` flow), the backend bootstrap injects the
 * project's bypass secret as `CODEAM_VERCEL_BYPASS` into the codespace
 * environment. Every HTTP call the CLI makes to the API then attaches
 * `x-vercel-protection-bypass: <secret>` so Vercel's edge DDoS shield
 * lets the CLI's polling/output burst through instead of serving a
 * 403 HTML challenge.
 *
 * Locally-installed CLIs (developer's laptop, CI, etc.) do NOT set the
 * env var — this helper returns `{}` and the request goes out without
 * the header, preserving today's behaviour. The header is opaque to
 * the API itself; it's enforced only at Vercel's edge.
 */
export function vercelBypassHeader(): Record<string, string> {
  const token = process.env.CODEAM_VERCEL_BYPASS;
  return token ? { 'x-vercel-protection-bypass': token } : {};
}
