import { describe, it, expect } from 'vitest';
import { RepoDirtyTracker } from '../../src/services/turn-files/repo-dirty-tracker';

describe('RepoDirtyTracker', () => {
  it('starts empty', () => {
    const t = new RepoDirtyTracker();
    expect(t.hasDirty()).toBe(false);
    expect(Array.from(t.peek())).toEqual([]);
  });

  it('markDirty is idempotent — same path added twice stays once', () => {
    const t = new RepoDirtyTracker();
    t.markDirty('/repos/a');
    t.markDirty('/repos/a');
    t.markDirty('/repos/a');
    expect(Array.from(t.consume())).toEqual(['/repos/a']);
  });

  it('markAllDirty seeds every supplied repo', () => {
    const t = new RepoDirtyTracker();
    t.markAllDirty([
      { repoRoot: '/repos/a' },
      { repoRoot: '/repos/b' },
      { repoRoot: '/repos/c' },
    ]);
    expect(t.hasDirty()).toBe(true);
    const snap = t.consume();
    expect(snap.has('/repos/a')).toBe(true);
    expect(snap.has('/repos/b')).toBe(true);
    expect(snap.has('/repos/c')).toBe(true);
    // consume() should leave the tracker empty.
    expect(t.hasDirty()).toBe(false);
  });

  it('peek does NOT clear the set; consume does', () => {
    const t = new RepoDirtyTracker();
    t.markDirty('/repos/a');
    expect(Array.from(t.peek())).toEqual(['/repos/a']);
    expect(t.hasDirty()).toBe(true);
    t.consume();
    expect(Array.from(t.peek())).toEqual([]);
    expect(t.hasDirty()).toBe(false);
  });

  it('events after consume re-populate the set for the next turn', () => {
    const t = new RepoDirtyTracker();
    t.markDirty('/repos/a');
    t.consume();
    t.markDirty('/repos/b');
    expect(Array.from(t.consume())).toEqual(['/repos/b']);
  });

  it('peek returns a snapshot — mutating the returned set does not leak back', () => {
    const t = new RepoDirtyTracker();
    t.markDirty('/repos/a');
    const view = t.peek() as Set<string>;
    view.add('/repos/sneaky');
    // Internal state stays clean.
    expect(Array.from(t.consume())).toEqual(['/repos/a']);
  });
});
