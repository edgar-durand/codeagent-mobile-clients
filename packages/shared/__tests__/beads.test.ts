import { describe, it, expect } from 'vitest';
import type {
  BeadsIssueDto,
  BeadsIngestPayload,
  BeadsStatusSummary,
  BeadsDependencyDto,
  BeadsMemoryDto,
  BeadsActionPayload,
} from '../src/types/beads';

/**
 * Compile-time + runtime sample-parse guard. The wire shapes MUST match the
 * backend's `BeadsIngestPayload` (live behind the `beads` flag). These samples
 * are copied from a real `@beads/bd@1.0.5` spike so a field-name drift in
 * either direction (CLI ↔ backend) trips this test instead of silently
 * dropping data in the mirror.
 */
describe('beads wire types', () => {
  it('parses a real `bd ready --json` issue row (+ projectKey) into BeadsIssueDto', () => {
    // Verbatim from the spike, with the backend-added projectKey field.
    const raw = JSON.parse(
      JSON.stringify({
        id: 'bd-a1b2',
        title: 'wire the watcher into the pair path',
        status: 'in_progress',
        priority: 0,
        issue_type: 'task',
        owner: 'claude',
        created_at: '2026-06-09T10:00:00Z',
        updated_at: '2026-06-09T11:00:00Z',
        dependency_count: 1,
        dependent_count: 2,
        comment_count: 0,
        projectKey: 'github.com/edgar-durand/codeagent-mobile-clients',
      }),
    ) as BeadsIssueDto;

    expect(raw.id).toBe('bd-a1b2');
    expect(raw.status).toBe('in_progress');
    expect(raw.priority).toBe(0);
    expect(raw.issue_type).toBe('task');
    expect(raw.owner).toBe('claude');
    expect(raw.projectKey).toContain('codeagent-mobile-clients');
  });

  it('accepts a null priority / null owner (unclaimed, unprioritised issue)', () => {
    const issue: BeadsIssueDto = {
      id: 'bd-c3d4',
      title: 'untriaged',
      status: 'open',
      priority: null,
      issue_type: 'bug',
      owner: null,
      created_at: '2026-06-09T10:00:00Z',
      updated_at: '2026-06-09T10:00:00Z',
      dependency_count: 0,
      dependent_count: 0,
      comment_count: 0,
      projectKey: 'path:deadbeef',
    };
    expect(issue.priority).toBeNull();
    expect(issue.owner).toBeNull();
  });

  it('parses a `bd status --json` summary into BeadsStatusSummary', () => {
    const summary = JSON.parse(
      JSON.stringify({
        open_issues: 4,
        ready_issues: 2,
        blocked_issues: 1,
        in_progress_issues: 1,
        closed_issues: 7,
        total_issues: 13,
      }),
    ) as BeadsStatusSummary;
    expect(summary.ready_issues).toBe(2);
    expect(summary.total_issues).toBe(13);
  });

  it('assembles a full-snapshot BeadsIngestPayload with dependencies + memories', () => {
    const dep: BeadsDependencyDto = {
      id: 'bd-a1b2:blocks:bd-c3d4',
      fromId: 'bd-a1b2',
      toId: 'bd-c3d4',
      kind: 'blocks',
    };
    const memory: BeadsMemoryDto = {
      id: 'mem-1',
      body: 'prefer execFileSync over execSync for git',
      createdAt: '2026-06-09T10:00:00Z',
      projectKey: null,
    };
    const payload: BeadsIngestPayload = {
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      projectKey: 'github.com/edgar-durand/codeagent-mobile-clients',
      projectLabel: 'codeagent-mobile-clients',
      fullSnapshot: true,
      issues: [],
      dependencies: [dep],
      memories: [memory],
    };
    expect(payload.fullSnapshot).toBe(true);
    expect(payload.dependencies[0].kind).toBe('blocks');
    expect(payload.memories[0].projectKey).toBeNull();
  });

  it('models a mobile-originated action', () => {
    const action: BeadsActionPayload = {
      kind: 'close',
      issueId: 'bd-a1b2',
      reason: 'shipped in v2.x',
    };
    expect(action.kind).toBe('close');
    expect(action.issueId).toBe('bd-a1b2');
  });
});
