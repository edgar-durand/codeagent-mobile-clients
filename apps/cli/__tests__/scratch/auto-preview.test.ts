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
    notePreviewBringUp('s1');
    const b = bridge();
    expect(maybeAutoOpenScratchPreview('s1', b, dir)).toBe(false);
    expect(b.start).not.toHaveBeenCalled();
  });
});
