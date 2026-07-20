/**
 * PR / MR Command Center — pull-request wire types (canonical home).
 *
 * Spec: docs/superpowers/specs/2026-07-18-pr-mr-command-center-design.md (§5, §6, §9, §10).
 *
 * These are the frozen shapes the backend `vcs` engine, the mobile PR panel,
 * and the CLI agent-review handler all agree on byte-for-byte. Pure data — no
 * platform imports. v1 is GitHub-only, but every shape is vendor-neutral so a
 * future GitLab/Bitbucket provider reuses them with ZERO panel/type change.
 */

/** A stable, cross-vendor reference to one pull/merge request. */
export interface PrRef {
  /** Repo owner / org (GitHub `owner`). */
  owner: string;
  /** Repo name (GitHub `repo`). */
  repo: string;
  /** PR number within the repo. */
  number: number;
  /** Canonical web URL, when known (e.g. `https://github.com/o/r/pull/12`). */
  url?: string;
}

/** The three review actions a reviewer (human or agent) can submit. */
export type PrReviewVerdict = 'approve' | 'request_changes' | 'comment';

/** One CI check / status on a PR head commit (GitHub Checks + commit statuses). */
export interface PrCheck {
  name: string;
  /** GitHub check-run status. */
  status: 'queued' | 'in_progress' | 'completed';
  /** Conclusion once `status === 'completed'`; null/absent while running. */
  conclusion?:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | null;
  /** Deep link to the check's details page. */
  detailsUrl?: string;
}

/** One existing review already on the PR (shown in the detail screen). */
export interface PrReviewEntry {
  /** Reviewer login. */
  author: string;
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending';
  submittedAt?: string;
  body?: string;
}

/**
 * A row in the PR Command Center panel (Review Requested / Your Open PRs).
 * Pulled on-open via the GitHub Search API — never polled.
 */
export interface PullRequestSummary {
  ref: PrRef;
  title: string;
  number: number;
  /** Author login. */
  author: string;
  state: 'open' | 'closed' | 'merged';
  isDraft?: boolean;
  /** Head → base branch names. */
  headBranch: string;
  baseBranch: string;
  updatedAt: string;
  /** `owner/repo`. */
  repoFullName: string;
  /** Aggregate review decision (GitHub `reviewDecision`). */
  reviewDecision?: 'approved' | 'changes_requested' | 'review_required' | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

/** The full PR detail screen payload — summary + body + checks + reviews. */
export interface PullRequestDetail extends PullRequestSummary {
  body?: string;
  checks?: PrCheck[];
  reviews?: PrReviewEntry[];
  /** GitHub mergeability; null while GitHub is still computing it. */
  mergeable?: boolean | null;
  /** Role flags the mobile UI uses to pick the action set (author vs reviewer). */
  viewerIsAuthor?: boolean;
  viewerIsRequestedReviewer?: boolean;
}

/** One finding an agent surfaced during a review (mirrors a CodeRabbit hunk). */
export interface AgentReviewFinding {
  /** Repo-relative file path. */
  path: string;
  /** 1-based line the finding anchors to, when locatable. */
  line?: number;
  severity?: 'info' | 'warn' | 'error';
  message: string;
}

/**
 * Phase-2 agent-review LAUNCH plan — what the backend composes when the user
 * taps "Ask an agent to review PR #X". Delivered to the review session so the
 * agent (ACP via initial prompt, or CodeRabbit via the CLI handler) knows what
 * to review and which toolkits it has.
 */
export interface AgentReviewPlan {
  prRef: PrRef;
  /** Which linked agent performs the review (`coderabbit`, `claude`, …). */
  agentId: string;
  /** The composed "review PR #X" initial prompt (ACP agents consume this). */
  prompt: string;
  /** `owner/repo` (or a provider-specific project identifier). */
  repoIdentifier: string;
  /** The PR head branch the deploy checks out and the review runs against. */
  branch: string;
  /** Toolkit integrations the review box is provisioned with (includes `github`). */
  integrationIds: string[];
  /** Curated skill id(s) attached to this session's purpose (e.g. `code-review`).
   *  Claude gets them as `~/.codeam/skills.json`; other agents get the instruction
   *  preamble prepended to `prompt` server-side. The client forwards these into the
   *  deploy request the same way as `integrationIds`. */
  skillIds: string[];
}

/**
 * Phase-2 agent-review RESULT — POSTed by the review session to
 * `POST /api/vcs/agent-review/report` once the agent finishes posting to
 * GitHub. Drives the completion push + Completion Result card.
 */
export interface AgentReviewReport {
  prRef: PrRef;
  agentId: string;
  /** The verdict the agent submitted to GitHub. */
  verdict: PrReviewVerdict;
  /** Number of inline comments the agent posted to GitHub. */
  commentCount: number;
  /** The findings behind the verdict (rendered in the Completion Result card). */
  findings?: AgentReviewFinding[];
}
