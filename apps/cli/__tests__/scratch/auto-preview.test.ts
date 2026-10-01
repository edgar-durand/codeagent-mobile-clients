import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hasServableProject,
  isEmptyScratchProject,
  maybeAutoOpenScratchPreview,
  notePreviewBringUp,
  resetAutoPreviewForTests,
} from '../../src/scratch/auto-preview';

let dir: string;

function makeScratch(): void {
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'codeam-scratch'), '');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
}

function bridge(status = 'idle') {
  return { status: vi.fn(() => ({ status })), start: vi.fn().mockResolvedValue({ status: 'running' }) };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-autoprev-'));
  resetAutoPreviewForTests();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('hasServableProject / isEmptyScratchProject', () => {
  it('an untouched scratch project (dotfiles + agent notes) is empty and not servable', () => {
    makeScratch();
    fs.mkdirSync(path.join(dir, '.beads'));
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# beads');
    expect(isEmptyScratchProject(dir)).toBe(true);
    expect(hasServableProject(dir)).toBe(false);
  });

  it('a static page or a package.json is servable', () => {
    makeScratch();
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>');
    expect(isEmptyScratchProject(dir)).toBe(false);
    expect(hasServableProject(dir)).toBe(true);
    fs.rmSync(path.join(dir, 'index.html'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    expect(hasServableProject(dir)).toBe(true);
  });

  it('public/index.html counts; a README alone does not', () => {
    makeScratch();
    fs.writeFileSync(path.join(dir, 'README.md'), '# x');
    expect(hasServableProject(dir)).toBe(false);
    fs.mkdirSync(path.join(dir, 'public'));
    fs.writeFileSync(path.join(dir, 'public', 'index.html'), '');
    expect(hasServableProject(dir)).toBe(true);
  });

  it('a built static site under dist/ or build/ counts (Vite/CRA output the agent never served)', () => {
    makeScratch();
    expect(hasServableProject(dir)).toBe(false);
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist', 'index.html'), '');
    expect(hasServableProject(dir)).toBe(true);
    fs.rmSync(path.join(dir, 'dist'), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'build'));
    fs.writeFileSync(path.join(dir, 'build', 'index.html'), '');
    expect(hasServableProject(dir)).toBe(true);
  });

  it('a repo that is not a scratch project is never "empty"', () => {
    fs.mkdirSync(path.join(dir, '.git'));
    expect(isEmptyScratchProject(dir)).toBe(false);
  });
});

describe('maybeAutoOpenScratchPreview', () => {
  it('opens the preview once when the agent built a page and never opened it (RCA 2026-09-30)', () => {
    makeScratch();
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>');
    const b = bridge();
    expect(maybeAutoOpenScratchPreview('s1', b, dir)).toBe(true);
    expect(b.start).toHaveBeenCalledTimes(1);
    // next turn: already attempted → never a second bring-up
    expect(maybeAutoOpenScratchPreview('s1', b, dir)).toBe(false);
    expect(b.start).toHaveBeenCalledTimes(1);
  });

  it('waits while there is nothing servable, then opens on the turn that adds it', () => {
    makeScratch();
    const b = bridge();
    expect(maybeAutoOpenScratchPreview('s1', b, dir)).toBe(false);
    fs.writeFileSync(path.join(dir, 'index.html'), '');
    expect(maybeAutoOpenScratchPreview('s1', b, dir)).toBe(true);
  });

  it('never runs outside a scratch project', () => {
    fs.writeFileSync(path.join(dir, 'index.html'), '');
    const b = bridge();
    expect(maybeAutoOpenScratchPreview('s1', b, dir)).toBe(false);
    expect(b.start).not.toHaveBeenCalled();
  });

  it('leaves it alone when the agent is already starting it, or its own start failed', () => {
    makeScratch();
    fs.writeFileSync(path.join(dir, 'index.html'), '');
    for (const status of ['starting', 'running', 'error']) {
      const b = bridge(status);
      expect(maybeAutoOpenScratchPreview(`s-${status}`, b, dir)).toBe(false);
      expect(b.start).not.toHaveBeenCalled();
    }
  });

  it('a preview the user started (and maybe stopped) in this process is never reopened', () => {
    makeScratch();
    fs.writeFileSync(path.join(dir, 'index.html'), '');
    notePreviewBringUp('s1', dir);
    const b = bridge();
    expect(maybeAutoOpenScratchPreview('s1', b, dir)).toBe(false);
    expect(b.start).not.toHaveBeenCalled();
  });

  // codeagent-rew3 follow-up: the in-process `bringUps` Set alone can't
  // survive a CLI restart (sleep/wake, supervisor restart, self-update) — a
  // preview the user explicitly stopped could auto-reopen once more on the
  // next qualifying turn. The on-disk marker under `.codeam/` must survive
  // `resetAutoPreviewForTests()` (which only clears the in-memory Set, same
  // as a fresh process would start).
  it('persists the attempt to disk so a process restart does not reopen a stopped preview', () => {
    makeScratch();
    fs.writeFileSync(path.join(dir, 'index.html'), '');
    const b1 = bridge();
    expect(maybeAutoOpenScratchPreview('s1', b1, dir)).toBe(true);
    expect(b1.start).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(dir, '.codeam', 'auto-preview-state.json'))).toBe(true);

    // Simulate a CLI restart: the in-process Set is gone, but the project
    // directory (and its marker) persists.
    resetAutoPreviewForTests();
    const b2 = bridge();
    expect(maybeAutoOpenScratchPreview('s1', b2, dir)).toBe(false);
    expect(b2.start).not.toHaveBeenCalled();
  });

  it('notePreviewBringUp (button/restore/restart path) also persists the marker for scratch projects', () => {
    makeScratch();
    fs.writeFileSync(path.join(dir, 'index.html'), '');
    notePreviewBringUp('s1', dir);
    expect(fs.existsSync(path.join(dir, '.codeam', 'auto-preview-state.json'))).toBe(true);
    resetAutoPreviewForTests();
    const b = bridge();
    expect(maybeAutoOpenScratchPreview('s1', b, dir)).toBe(false);
    expect(b.start).not.toHaveBeenCalled();
  });

  it('does NOT write a marker for a non-scratch project (no "once per project" rule to persist)', () => {
    fs.writeFileSync(path.join(dir, 'index.html'), '');
    notePreviewBringUp('s1', dir);
    expect(fs.existsSync(path.join(dir, '.codeam'))).toBe(false);
  });
});
