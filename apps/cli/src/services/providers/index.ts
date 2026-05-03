import type { CloudProvider } from './types';
import { GitHubCodespacesProvider } from './github-codespaces';
import { GitpodProvider } from './gitpod';
import { GitLabWorkspacesProvider } from './gitlab-workspaces';
import { RailwayProvider } from './railway';

/**
 * Registry of cloud-workspace providers. Order matters: it's the
 * order users see in the picker. Add new providers by implementing
 * `CloudProvider` and pushing them onto the list — the orchestrator
 * (`commands/deploy.ts`) is provider-agnostic.
 *
 * Each provider leans on its native CLI for auth (gh / gitpod /
 * glab / railway) so we don't have to re-implement OAuth or store
 * tokens. The first-time prompt for a missing CLI / login surfaces
 * the install command and exits cleanly.
 */
export const PROVIDERS: CloudProvider[] = [
  new GitHubCodespacesProvider(),
  new GitpodProvider(),
  new GitLabWorkspacesProvider(),
  new RailwayProvider(),
];

export type {
  CloudProvider,
  DeployableProject,
  ExecResult,
  ExistingWorkspace,
  MachineType,
  Workspace,
} from './types';
