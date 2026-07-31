import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectRepoDeps, detectRepoStack } from '../../src/integrations/detect-stack';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-stack-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function write(rel: string, content: string) {
  fs.writeFileSync(path.join(dir, rel), content, 'utf8');
}

describe('collectRepoDeps', () => {
  it('reads package.json dependencies + devDependencies', () => {
    write(
      'package.json',
      JSON.stringify({
        dependencies: { react: '^19', '@sentry/nextjs': '^8' },
        devDependencies: { vite: '^5' },
      }),
    );
    const deps = collectRepoDeps(dir);
    expect(deps).toContain('react');
    expect(deps).toContain('@sentry/nextjs');
    expect(deps).toContain('vite');
  });

  it('reads requirements.txt names (strips versions/comments)', () => {
    write('requirements.txt', '# deps\nfastapi==0.110\nsentry-sdk>=1.0\n-e .\n');
    const deps = collectRepoDeps(dir);
    expect(deps).toContain('fastapi');
    expect(deps).toContain('sentry-sdk');
    expect(deps).not.toContain('#');
  });

  it('reads go.mod require module paths', () => {
    write('go.mod', 'module example.com/x\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n');
    const deps = collectRepoDeps(dir);
    expect(deps.some((d) => d.includes('gin'))).toBe(true);
  });

  it('is empty (no throw) on a repo with no dependency manifests', () => {
    expect(collectRepoDeps(dir)).toEqual([]);
  });
});

describe('detectRepoStack', () => {
  it('a React + Sentry repo → frontend, detects sentry, recommends figma/posthog/vercel', async () => {
    write('package.json', JSON.stringify({ dependencies: { react: '^19', '@sentry/react': '^8' } }));
    const d = await detectRepoStack(dir);
    expect(d.source).toBe('scan');
    expect(['frontend', 'fullstack']).toContain(d.stack);
    expect(d.detected).toContain('sentry');
    expect(d.recommended).toContain('figma');
    expect(d.recommended).not.toContain('sentry'); // already detected
  });

  it('a NestJS + convex repo → backend, detects convex', async () => {
    write('package.json', JSON.stringify({ dependencies: { '@nestjs/core': '^10', convex: '^1' } }));
    const d = await detectRepoStack(dir);
    expect(d.stack).toBe('backend');
    expect(d.detected).toContain('convex');
  });

  it('empty scan falls back to the agent one-shot (B), constrained to the catalog', async () => {
    write('package.json', JSON.stringify({ dependencies: { 'left-pad': '^1' } }));
    const runtime = {
      generateOneShot: async () => '["posthog", "not_a_real_tool", "sentry"]',
    };
    const d = await detectRepoStack(dir, runtime);
    expect(d.source).toBe('agent');
    expect(d.recommended).toEqual(['posthog', 'sentry']); // bogus id filtered out
  });

  it('empty scan + no agent available → empty scan result (never throws)', async () => {
    write('package.json', JSON.stringify({ dependencies: { 'left-pad': '^1' } }));
    const d = await detectRepoStack(dir);
    expect(d.detected).toEqual([]);
    expect(d.recommended).toEqual([]);
    expect(d.source).toBe('scan');
  });
});
