import { describe, it, expect, vi } from 'vitest';
import type { PrRef } from '@codeam/shared';
import {
  decidePrVerdict,
  buildPrReviewBody,
  buildInlineCommentArgs,
  buildReviewVerdictArgs,
  toAgentReviewFindings,
  buildAgentReviewReport,
  reviewPullRequest,
  type RunGhResult,
  type ReviewPullRequestDeps,
} from '../../../src/agents/coderabbit/review-pr';
import type { BatchInvocationInput, BatchInvocationOutput } from '../../../src/agents/strategy';

const PR: PrRef = { owner: 'acme', repo: 'web', number: 42, url: 'https://github.com/acme/web/pull/42' };

type Hunk = NonNullable<BatchInvocationOutput['hunks']>[number];

// ─── Pure mappers ────────────────────────────────────────────────────────────

describe('decidePrVerdict', () => {
  it('request_changes when there is a critical finding', () => {
    expect(decidePrVerdict({ findingCount: 3, critical: 1, warning: 1, info: 1 })).toBe('request_changes');
  });
  it('comment when there are findings but no critical', () => {
    expect(decidePrVerdict({ findingCount: 2, critical: 0, warning: 1, info: 1 })).toBe('comment');
  });
  it('approve on a clean review', () => {
    expect(decidePrVerdict({ findingCount: 0, critical: 0, warning: 0, info: 0 })).toBe('approve');
  });
  it('approve when stats is missing entirely', () => {
    expect(decidePrVerdict(undefined)).toBe('approve');
  });
});

describe('buildInlineCommentArgs', () => {
  it('maps a hunk to a `gh api` POST that form-encodes body/path/line and pins commit_id + side (env-only auth, no shell)', () => {
    const hunk: Hunk = { path: 'src/b.ts', line: 7, severity: 'warn', message: 'unused var' };
    expect(buildInlineCommentArgs(PR, hunk, 'sha123')).toEqual([
      'api',
      '--method',
      'POST',
      '/repos/acme/web/pulls/42/comments',
      '-f',
      'body=🟡 Warning: unused var',
      '-f',
      'commit_id=sha123',
      '-f',
      'path=src/b.ts',
      '-F',
      'line=7',
      '-f',
      'side=RIGHT',
    ]);
  });
});

describe('buildReviewVerdictArgs', () => {
  it('maps approve → --approve', () => {
    expect(buildReviewVerdictArgs(PR, 'approve', 'lgtm')).toEqual([
      'pr', 'review', '42', '--repo', 'acme/web', '--approve', '--body', 'lgtm',
    ]);
  });
  it('maps request_changes → --request-changes', () => {
    expect(buildReviewVerdictArgs(PR, 'request_changes', 'fix it')[5]).toBe('--request-changes');
  });
  it('maps comment → --comment', () => {
    expect(buildReviewVerdictArgs(PR, 'comment', 'nits')[5]).toBe('--comment');
  });
});

describe('toAgentReviewFindings / buildAgentReviewReport', () => {
  it('projects hunks and omits empty findings', () => {
    const hunks: Hunk[] = [
      { path: 'a.ts', line: 1, severity: 'error', message: 'x' },
      { path: 'b.ts', message: 'y' }, // no line / severity
    ];
    expect(toAgentReviewFindings(hunks)).toEqual([
      { path: 'a.ts', line: 1, severity: 'error', message: 'x' },
      { path: 'b.ts', message: 'y' },
    ]);
    const report = buildAgentReviewReport(PR, 'coderabbit', 'request_changes', hunks, 2);
    expect(report).toEqual({
      prRef: PR,
      agentId: 'coderabbit',
      verdict: 'request_changes',
      commentCount: 2,
      findings: [
        { path: 'a.ts', line: 1, severity: 'error', message: 'x' },
        { path: 'b.ts', message: 'y' },
      ],
    });
  });
  it('omits `findings` when there are none (clean approve)', () => {
    const report = buildAgentReviewReport(PR, 'coderabbit', 'approve', [], 0);
    expect(report).toEqual({ prRef: PR, agentId: 'coderabbit', verdict: 'approve', commentCount: 0 });
    expect('findings' in report).toBe(false);
  });
});

describe('buildPrReviewBody', () => {
  it('uses the reviewer summary + notes inline count', () => {
    const body = buildPrReviewBody(
      { markdown: 'Two issues found.', hunks: [], stats: { findingCount: 2, critical: 0, warning: 2, info: 0 } },
      2,
    );
    expect(body).toContain('Two issues found.');
    expect(body).toContain('2 inline comments posted.');
    expect(body).toContain('CodeRabbit review');
  });
  it('falls back to a clean message with no summary + no findings', () => {
    const body = buildPrReviewBody({ markdown: '', hunks: [], stats: { findingCount: 0, critical: 0, warning: 0, info: 0 } }, 0);
    expect(body).toContain('No issues found');
    expect(body).not.toContain('inline comment');
  });
});

// ─── Orchestrator ─────────────────────────────────────────────────────────────

interface MakeDepsOverrides {
  runReview?: ReviewPullRequestDeps['runReview'];
  /** Responder for `gh` calls — every call is still recorded in `ghCalls`. */
  gh?: (args: string[]) => RunGhResult;
}

function makeDeps(overrides: MakeDepsOverrides = {}): {
  deps: ReviewPullRequestDeps;
  ghCalls: string[][];
  reports: unknown[];
} {
  const ghCalls: string[][] = [];
  const reports: unknown[] = [];
  const defaultGh = (args: string[]): RunGhResult => {
    // The `pr view … headRefOid` probe returns the head SHA.
    if (args[0] === 'pr' && args[1] === 'view') return { code: 0, stdout: 'abc123sha\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const respond = overrides.gh ?? defaultGh;
  const deps: ReviewPullRequestDeps = {
    runReview:
      overrides.runReview ??
      (async (_input: BatchInvocationInput) => ({
        exitCode: 0,
        markdown: 'Found 2 issues.',
        hunks: [
          { path: 'src/a.ts', line: 10, severity: 'error', message: 'null deref' },
          { path: 'src/b.ts', line: 20, severity: 'warn', message: 'unused import' },
        ],
        stats: { findingCount: 2, critical: 1, warning: 1, info: 0 },
      })),
    runGh: async (args: string[]): Promise<RunGhResult> => {
      ghCalls.push(args);
      return respond(args);
    },
    postReport: async (r) => {
      reports.push(r);
    },
  };
  return { deps, ghCalls, reports };
}

describe('reviewPullRequest — orchestrator', () => {
  it('reviews the PR diff, posts one inline comment per finding, submits request_changes, POSTs the report', async () => {
    const { deps, ghCalls, reports } = makeDeps();
    const runReview = vi.fn(deps.runReview);
    const report = await reviewPullRequest({ prRef: PR, agentId: 'coderabbit', baseBranch: 'main' }, { ...deps, runReview });

    // Reviewed committed changes vs the base branch.
    expect(runReview).toHaveBeenCalledWith(expect.objectContaining({ changeSet: 'committed', base: 'main', structured: true }));

    // gh call sequence: head-sha probe, 2 inline comments, 1 verdict.
    expect(ghCalls[0].slice(0, 2)).toEqual(['pr', 'view']);
    const commentCalls = ghCalls.filter((a) => a[0] === 'api');
    expect(commentCalls).toHaveLength(2);
    expect(commentCalls[0]).toContain('commit_id=abc123sha');
    const verdictCall = ghCalls.find((a) => a[0] === 'pr' && a[1] === 'review');
    expect(verdictCall).toBeDefined();
    expect(verdictCall).toContain('--request-changes');

    // Report shape.
    expect(report.verdict).toBe('request_changes');
    expect(report.commentCount).toBe(2);
    expect(report.findings).toHaveLength(2);
    expect(reports[0]).toEqual(report);
  });

  it('approves + posts no inline comments on a clean review', async () => {
    const { deps, ghCalls } = makeDeps({
      runReview: async () => ({ exitCode: 0, markdown: '', hunks: [], stats: { findingCount: 0, critical: 0, warning: 0, info: 0 } }),
    });
    const report = await reviewPullRequest({ prRef: PR, agentId: 'coderabbit' }, deps);
    expect(report.verdict).toBe('approve');
    expect(report.commentCount).toBe(0);
    expect(ghCalls.filter((a) => a[0] === 'api')).toHaveLength(0);
    expect(ghCalls.find((a) => a[1] === 'review')).toContain('--approve');
  });

  it('skips inline comments (but still submits + reports) when the head-sha probe fails', async () => {
    const { deps, ghCalls } = makeDeps({
      gh: (args) => {
        if (args[0] === 'pr' && args[1] === 'view') return { code: 1, stdout: '', stderr: 'not found' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const report = await reviewPullRequest({ prRef: PR, agentId: 'coderabbit' }, deps);
    expect(ghCalls.filter((a) => a[0] === 'api')).toHaveLength(0);
    expect(report.commentCount).toBe(0);
    expect(ghCalls.find((a) => a[1] === 'review')).toBeDefined();
  });

  it('counts only inline comments that gh accepted (non-zero exit is skipped)', async () => {
    let n = 0;
    const { deps } = makeDeps({
      gh: (args) => {
        if (args[0] === 'pr' && args[1] === 'view') return { code: 0, stdout: 'sha\n', stderr: '' };
        if (args[0] === 'api') {
          n += 1;
          return { code: n === 1 ? 0 : 1, stdout: '', stderr: n === 1 ? '' : 'boom' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const report = await reviewPullRequest({ prRef: PR, agentId: 'coderabbit' }, deps);
    expect(report.commentCount).toBe(1); // second comment failed
  });
});
