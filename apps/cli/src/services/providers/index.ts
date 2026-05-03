import type { CloudProvider } from './types';
import { GitHubCodespacesProvider } from './github-codespaces';

/**
 * Registry of cloud-workspace providers. Order matters: it's the order
 * users see in the picker. Add new providers by implementing
 * `CloudProvider` and pushing them onto the list — the orchestrator
 * (`commands/deploy.ts`) is provider-agnostic.
 *
 * Placeholders with `available: false` show in the menu as "coming
 * soon" so users can see what's on the roadmap without us having to
 * ship empty subcommands.
 */
export const PROVIDERS: CloudProvider[] = [
  new GitHubCodespacesProvider(),
  // Sketches for future providers — uncomment + implement when ready.
  // new GitpodProvider(),
  // new CoderProvider(),
  // new GitLabWebIDEProvider(),
];

export type { CloudProvider, DeployableProject, Workspace, ExecResult } from './types';
