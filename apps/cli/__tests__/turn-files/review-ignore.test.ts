import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeReviewIgnore } from '../../src/services/turn-files/review-ignore';

describe('makeReviewIgnore', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ignore-'));
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('drops gcloud SDK install trees (the 2026-07-16 incident)', () => {
    const ig = makeReviewIgnore(repo);
    expect(ig('google-cloud-sdk/lib/surface/batch/jobs/delete.py')).toBe(true);
    expect(ig('google-cloud-sdk/lib/googlecloudsdk/api_lib/foo.py')).toBe(true);
  });

  it('drops common out-of-venv python + toolchain installs', () => {
    const ig = makeReviewIgnore(repo);
    expect(ig('some/path/site-packages/pkg/mod.py')).toBe(true);
    expect(ig('.local/lib/python3.11/thing.py')).toBe(true);
    expect(ig('.cargo/registry/src/crate/lib.rs')).toBe(true);
    expect(ig('.codeam/anything.json')).toBe(true);
  });

  it('does NOT drop real source files', () => {
    const ig = makeReviewIgnore(repo);
    expect(ig('src/index.ts')).toBe(false);
    expect(ig('apps/api/main.py')).toBe(false);
    expect(ig('README.md')).toBe(false);
  });

  it('honors a per-repo .codeam/reviewignore extension', () => {
    fs.mkdirSync(path.join(repo, '.codeam'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.codeam', 'reviewignore'), 'generated/\n*.snap\n');
    const ig = makeReviewIgnore(repo);
    expect(ig('generated/schema.ts')).toBe(true);
    expect(ig('src/foo.snap')).toBe(true);
    expect(ig('src/foo.ts')).toBe(false); // still reviewed
  });

  it('is safe on empty / odd input', () => {
    const ig = makeReviewIgnore(repo);
    expect(ig('')).toBe(false);
  });
});
