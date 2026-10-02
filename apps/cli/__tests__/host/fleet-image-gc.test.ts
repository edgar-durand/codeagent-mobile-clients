import { describe, it, expect } from 'vitest';
import {
  parseFleetImageInspect,
  planFleetBoxImageGc,
  repoOfImageRef,
  type FleetImageInfo,
} from '../../src/commands/host/fleet-image-gc';

const BOX = 'ghcr.io/edgar-durand/codeam-box';
const REF = `${BOX}:latest`;

function img(id: string, created: string, repoTags: string[] = [], base = 'sha256:base'): FleetImageInfo {
  return { id, created, repoTags, layers: [base, `sha256:${id}-top`] };
}

describe('repoOfImageRef', () => {
  it('strips the tag, keeping a registry port', () => {
    expect(repoOfImageRef(REF)).toBe(BOX);
    expect(repoOfImageRef('codeam-box:fix')).toBe('codeam-box');
    expect(repoOfImageRef('localhost:5000/codeam-box:latest')).toBe('localhost:5000/codeam-box');
    expect(repoOfImageRef('localhost:5000/codeam-box')).toBe('localhost:5000/codeam-box');
  });
});

describe('parseFleetImageInspect', () => {
  it('reads tagged and dangling rows and skips noise', () => {
    const rows = parseFleetImageInspect(
      [
        `sha256:a|2026-10-01T18:12:49Z|${REF}|sha256:l1,sha256:l2`,
        'sha256:b|2026-10-01T11:59:20Z||sha256:l1,sha256:l3',
        '',
        'Error: something',
      ].join('\n'),
    );
    expect(rows).toEqual([
      { id: 'sha256:a', created: '2026-10-01T18:12:49Z', repoTags: [REF], layers: ['sha256:l1', 'sha256:l2'] },
      { id: 'sha256:b', created: '2026-10-01T11:59:20Z', repoTags: [], layers: ['sha256:l1', 'sha256:l3'] },
    ]);
  });
});

describe('planFleetBoxImageGc', () => {
  const plan = (images: FleetImageInfo[], referenced: string[] = []) =>
    planFleetBoxImageGc({ images, referenced: new Set(referenced), currentId: 'cur', currentRef: REF });

  it('fleet-1 2026-10-02: keeps the newest previous as rollback and removes `:fix`', () => {
    const p = plan(
      [
        img('cur', '2026-10-01T18:12:49Z', [REF]),
        img('prev1', '2026-10-01T11:59:20Z'),
        img('prev2', '2026-10-01T01:42:46Z'),
        img('pinned', '2026-09-29T23:48:02Z'),
        img('fix', '2026-07-24T15:31:31Z', ['codeam-box:fix'], 'sha256:old'),
        img('node', '2026-07-14T01:48:37Z', ['node:22-slim'], 'sha256:old'),
      ],
      ['cur', 'pinned'],
    );
    expect(p).toEqual({ rollback: { id: 'prev1', tagAs: `${BOX}:rollback` }, removeTags: ['codeam-box:fix'] });
  });

  it('a tagged previous is kept as-is, with no extra tag', () => {
    const p = plan([img('cur', '2026-10-02T00:00:00Z', [REF]), img('fix', '2026-07-24T00:00:00Z', ['codeam-box:fix'])]);
    expect(p).toEqual({ rollback: { id: 'fix' }, removeTags: [] });
  });

  it('a new release moves the rollback tag and never rmi-s it by name', () => {
    const p = plan([
      img('cur', '2026-10-03T00:00:00Z', [REF]),
      img('prev', '2026-10-02T00:00:00Z'),
      img('oldrb', '2026-10-01T00:00:00Z', [`${BOX}:rollback`]),
    ]);
    // Re-tagging `prev` untags `oldrb`, and the dangling prune collects it.
    expect(p).toEqual({ rollback: { id: 'prev', tagAs: `${BOX}:rollback` }, removeTags: [] });
  });

  it('an older `:rollback` holder is removed when no tag move happens', () => {
    const p = plan([
      img('cur', '2026-10-03T00:00:00Z', [REF]),
      img('fix', '2026-10-02T00:00:00Z', ['codeam-box:fix']),
      img('oldrb', '2026-10-01T00:00:00Z', [`${BOX}:rollback`]),
    ]);
    expect(p).toEqual({ rollback: { id: 'fix' }, removeTags: [`${BOX}:rollback`] });
  });

  it('never returns a referenced image, the current image, or a non-Box tag', () => {
    const p = plan(
      [
        img('cur', '2026-10-03T00:00:00Z', [REF, 'mine:keep']),
        img('prev', '2026-10-02T00:00:00Z', [`${BOX}:v1`]),
        img('used', '2026-10-01T00:00:00Z', [`${BOX}:v0`]),
        img('mixed', '2026-09-30T00:00:00Z', [`${BOX}:v-1`, 'someone:else']),
        img('foreign', '2026-09-29T00:00:00Z', ['postgres:16']),
      ],
      ['used'],
    );
    expect(p.removeTags).toEqual([`${BOX}:v-1`]);
  });

  it('removes nothing when the current image is not in the list', () => {
    expect(plan([img('prev', '2026-10-02T00:00:00Z', ['codeam-box:fix'])])).toEqual({ removeTags: [] });
  });

  it('no previous release → no rollback', () => {
    expect(plan([img('cur', '2026-10-02T00:00:00Z', [REF])])).toEqual({ rollback: undefined, removeTags: [] });
  });
});
