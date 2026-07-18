/**
 * CodeRabbit PR-review path — the Phase-2 "Ask an agent to review PR #X" flow
 * for the ONE agent that isn't ACP.
 *
 * Spec: docs/superpowers/specs/2026-07-18-pr-mr-command-center-design.md (§6.2–§6.4).
 *
 * ACP agents (claude / codex / gemini) review + post to GitHub themselves via
 * their prompt + the `gh` tool — no code here. CodeRabbit is a one-shot batch
 * reviewer with NO GitHub-posting of its own, so the CLI must:
 *   1. run `coderabbit review` over the checked-out PR branch,
 *   2. parse its findings (reuses `parsing.ts` via the runtime's parsed output),
 *   3. post them to GitHub with `gh` — inline comments via `gh api`, then a
 *      verdict via `gh pr review --approve|--request-changes|--comment`,
 *   4. return an {@link AgentReviewReport} the caller POSTs to the backend.
 *
 * The GitHub session box already has `gh` authenticated (the deploy checked out
 * the repo with the user's token), so posting is agent-agnostic — this module
 * just maps findings → `gh` argv. Every process boundary is a DI'd dep so the
 * parse→gh-args mapping and the report shape unit-test without a real `gh`.
 */

import { spawn } from 'node:child_process';
import type {
  AgentReviewFinding,
  AgentReviewReport,
  PrRef,
  PrReviewVerdict,
} from '@codeam/shared';
import type { ParsedReview } from './parsing';
import type { BatchInvocationInput, BatchInvocationOutput } from '../strategy';

/** One parsed CodeRabbit finding (a `ParsedReview` hunk). */
type Hunk = ParsedReview['hunks'][number];

/** `owner/repo` — the argument every `gh` subcommand takes via `--repo`. */
function repoSlug(prRef: PrRef): string {
  return `${prRef.owner}/${prRef.repo}`;
}

/**
 * Decide the verdict from the review's severity stats:
 *   - any `error`/`critical` finding → `request_changes`;
 *   - otherwise findings present → `comment`;
 *   - a clean review → `approve`.
 * Pure over the runtime's `stats` blob (finding counts).
 */
export function decidePrVerdict(stats: BatchInvocationOutput['stats']): PrReviewVerdict {
  const critical = numStat(stats, 'critical');
  const findingCount = numStat(stats, 'findingCount');
  if (critical > 0) return 'request_changes';
  if (findingCount > 0) return 'comment';
  return 'approve';
}

function numStat(stats: BatchInvocationOutput['stats'], key: string): number {
  const v = stats?.[key];
  return typeof v === 'number' ? v : 0;
}

/** Map a parsed hunk severity → a short badge for the review comment body. */
function severityBadge(sev: Hunk['severity']): string {
  if (sev === 'error') return '🔴 Critical';
  if (sev === 'warn') return '🟡 Warning';
  if (sev === 'info') return '🔵 Suggestion';
  return 'Note';
}

/**
 * The summary body posted with the review verdict. Never dumps the raw
 * `--agent` NDJSON — uses the reviewer's own markdown summary when present,
 * else a synthesized one-liner, always suffixed with the CodeRabbit attribution.
 */
export function buildPrReviewBody(parsed: ParsedReview, commentCount: number): string {
  const head =
    parsed.markdown.trim().length > 0
      ? parsed.markdown.trim()
      : parsed.hunks.length === 0
        ? 'No issues found — looks good to me.'
        : `Found ${parsed.hunks.length} issue${parsed.hunks.length === 1 ? '' : 's'}.`;
  const inline =
    commentCount > 0
      ? `\n\n${commentCount} inline comment${commentCount === 1 ? '' : 's'} posted.`
      : '';
  return `🐇 **CodeRabbit review**\n\n${head}${inline}`;
}

/**
 * Build the `gh api` argv that posts ONE inline review comment.
 * Credentials never touch argv — `gh` reads GH_TOKEN/GITHUB_TOKEN from env.
 * Values are passed via `-f key=value` (`-F` for the numeric line) so `gh`
 * form-encodes them; nothing is shell-interpolated.
 */
export function buildInlineCommentArgs(prRef: PrRef, hunk: Hunk, headSha: string): string[] {
  return [
    'api',
    '--method',
    'POST',
    `/repos/${prRef.owner}/${prRef.repo}/pulls/${prRef.number}/comments`,
    '-f',
    `body=${severityBadge(hunk.severity)}: ${hunk.message}`,
    '-f',
    `commit_id=${headSha}`,
    '-f',
    `path=${hunk.path}`,
    '-F',
    `line=${hunk.line}`,
    '-f',
    'side=RIGHT',
  ];
}

/** `gh pr review` argv for the verdict + summary body. */
export function buildReviewVerdictArgs(
  prRef: PrRef,
  verdict: PrReviewVerdict,
  body: string,
): string[] {
  const flag =
    verdict === 'approve'
      ? '--approve'
      : verdict === 'request_changes'
        ? '--request-changes'
        : '--comment';
  return [
    'pr',
    'review',
    String(prRef.number),
    '--repo',
    repoSlug(prRef),
    flag,
    '--body',
    body,
  ];
}

/** Project parsed hunks into the report's finding shape. */
export function toAgentReviewFindings(hunks: Hunk[]): AgentReviewFinding[] {
  return hunks.map((h) => ({
    path: h.path,
    ...(typeof h.line === 'number' ? { line: h.line } : {}),
    ...(h.severity ? { severity: h.severity } : {}),
    message: h.message,
  }));
}

/** Assemble the {@link AgentReviewReport} the caller POSTs to the backend. */
export function buildAgentReviewReport(
  prRef: PrRef,
  agentId: string,
  verdict: PrReviewVerdict,
  hunks: Hunk[],
  commentCount: number,
): AgentReviewReport {
  const findings = toAgentReviewFindings(hunks);
  return {
    prRef,
    agentId,
    verdict,
    commentCount,
    ...(findings.length > 0 ? { findings } : {}),
  };
}

export interface RunGhResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ReviewPullRequestParams {
  prRef: PrRef;
  /** The reviewing agent id — always `coderabbit` on this path. */
  agentId: string;
  /** The PR base branch, so CodeRabbit reviews the PR diff (committed vs base). */
  baseBranch?: string;
}

export interface ReviewPullRequestDeps {
  /** Run `coderabbit review` and return the parsed batch output. */
  runReview: (input: BatchInvocationInput) => Promise<BatchInvocationOutput>;
  /** Invoke `gh <args>`; resolves (never rejects) with the exit code + output. */
  runGh: (args: string[]) => Promise<RunGhResult>;
  /** POST the finished report to the backend (fire-and-forget upstream). */
  postReport: (report: AgentReviewReport) => Promise<void>;
}

/**
 * Orchestrate a CodeRabbit PR review end-to-end: review → parse → post to
 * GitHub via `gh` → build + POST the report. All I/O is in `deps` so this
 * composes from unit-tested pure mappers. Best-effort throughout — a failed
 * inline comment doesn't abort the verdict, and the report is always built
 * from what actually landed.
 */
export async function reviewPullRequest(
  params: ReviewPullRequestParams,
  deps: ReviewPullRequestDeps,
): Promise<AgentReviewReport> {
  const { prRef, agentId } = params;

  // 1. Review the PR diff — committed changes on the checked-out head branch
  //    against the PR base branch. Structured `--agent` output (default).
  const out = await deps.runReview({
    changeSet: 'committed',
    ...(params.baseBranch ? { base: params.baseBranch } : {}),
    structured: true,
  });
  const parsed: ParsedReview = {
    markdown: out.markdown ?? '',
    hunks: out.hunks ?? [],
    stats: out.stats ?? { findingCount: 0, critical: 0, warning: 0, info: 0 },
  };

  // 2. Resolve the head commit SHA — required by the PR review-comments API.
  //    Without it we can't anchor inline comments, so we skip them (the verdict
  //    body still carries the summary).
  let headSha = '';
  try {
    const meta = await deps.runGh([
      'pr',
      'view',
      String(prRef.number),
      '--repo',
      repoSlug(prRef),
      '--json',
      'headRefOid',
      '-q',
      '.headRefOid',
    ]);
    if (meta.code === 0) headSha = meta.stdout.trim();
  } catch {
    /* leave headSha empty → no inline comments */
  }

  // 3. Post inline comments for every locatable finding.
  let commentCount = 0;
  if (headSha) {
    for (const hunk of parsed.hunks) {
      if (typeof hunk.line !== 'number') continue;
      try {
        const r = await deps.runGh(buildInlineCommentArgs(prRef, hunk, headSha));
        if (r.code === 0) commentCount += 1;
      } catch {
        /* best-effort: one failed comment doesn't sink the review */
      }
    }
  }

  // 4. Submit the verdict + summary body.
  const verdict = decidePrVerdict(parsed.stats);
  const body = buildPrReviewBody(parsed, commentCount);
  try {
    await deps.runGh(buildReviewVerdictArgs(prRef, verdict, body));
  } catch {
    /* best-effort: the report still records the intended verdict */
  }

  // 5. Build + hand off the report.
  const report = buildAgentReviewReport(prRef, agentId, verdict, parsed.hunks, commentCount);
  await deps.postReport(report);
  return report;
}

/**
 * Default `gh` runner: spawns the real `gh` binary with argv only (no shell,
 * no secret on argv — `gh` reads GH_TOKEN/GITHUB_TOKEN from the inherited env),
 * and RESOLVES with the exit code + captured output (never rejects), mirroring
 * the `DockerRunner` discipline in host-agent.ts.
 */
export function defaultRunGh(args: string[]): Promise<RunGhResult> {
  return new Promise<RunGhResult>((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let proc;
    try {
      proc = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    proc.stdout?.on('data', (b: Buffer) => stdout.push(b));
    proc.stderr?.on('data', (b: Buffer) => stderr.push(b));
    proc.on('error', (err) => {
      resolve({ code: -1, stdout: '', stderr: err.message });
    });
    proc.on('close', (code) => {
      resolve({
        code: code ?? 0,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}
