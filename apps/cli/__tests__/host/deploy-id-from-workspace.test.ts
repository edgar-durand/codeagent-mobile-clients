/**
 * `deployIdFromWorkspace` — recovering a deploy's id from its workspace path.
 *
 * The CLI persists a session's deploy WORKSPACE (`SavedSession.cwd`) but not the
 * deployId, and on a supervisor-boot resume the deployId is the only id the
 * backend will match (`SelfHostedSession.deployId`). Reporting the wrong one
 * ended live session links on every boot — see the host-agent suite's
 * "boot reconcile reports the resumed child under its DEPLOY id" test.
 *
 * The negative cases matter as much as the positive one: a wrong-but-plausible
 * id is worse than none, because the caller falls back only on null.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { deployIdFromWorkspace, selfHostedWorkspaceRoot } from '../../src/commands/host/workspace';

describe('deployIdFromWorkspace', () => {
  const root = selfHostedWorkspaceRoot();

  it('recovers the deployId from a real deploy workspace', () => {
    const deployId = 'ba82b365-187b-4c00-b293-49fdd82326f8';
    expect(deployIdFromWorkspace(path.join(root, deployId))).toBe(deployId);
  });

  it('tolerates a trailing separator and a non-normalized path', () => {
    const deployId = 'dep-1';
    expect(deployIdFromWorkspace(path.join(root, deployId) + path.sep)).toBe(deployId);
    expect(deployIdFromWorkspace(path.join(root, 'other', '..', deployId))).toBe(deployId);
  });

  it('returns null for a path OUTSIDE the self-hosted root (a local pairing)', () => {
    // A local session's cwd is the user's own repo — it has no deployId at all,
    // and inventing one would report a bogus id to the backend.
    expect(deployIdFromWorkspace(path.join(path.sep, 'Users', 'someone', 'code', 'my-repo'))).toBeNull();
  });

  it('returns null for the root itself and for a nested path below a deploy', () => {
    expect(deployIdFromWorkspace(root)).toBeNull();
    // `<root>/<deployId>/<repo>` is one level too deep: the basename there is
    // the repo, not the deploy, and returning it would be silently wrong.
    expect(deployIdFromWorkspace(path.join(root, 'dep-1', 'repo'))).toBeNull();
  });

  it('returns null for a sibling directory that merely shares the prefix', () => {
    expect(deployIdFromWorkspace(root + '-other')).toBeNull();
  });

  it('returns null for empty / missing input', () => {
    expect(deployIdFromWorkspace(undefined)).toBeNull();
    expect(deployIdFromWorkspace(null)).toBeNull();
    expect(deployIdFromWorkspace('')).toBeNull();
  });
});
