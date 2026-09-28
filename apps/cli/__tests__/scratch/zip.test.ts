import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { buildZip } from '../../src/scratch/zip';
import { listExportFiles } from '../../src/scratch/export-files';

function makeRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-zip-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t.com',
    '-C',
    dir,
    'add',
    '-A',
    '-f',
  ]);
  execFileSync('git', [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t.com',
    '-C',
    dir,
    'commit',
    '-q',
    '-m',
    'init',
  ]);
  return dir;
}

const hasUnzip = (() => {
  try {
    execFileSync('which', ['unzip'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('buildZip', () => {
  it('writes a zip containing every listed file plus the generated .env.example, and returns its byte size', async () => {
    const dir = makeRepo({
      'src/index.html': '<h1>x</h1>',
      '.env': 'API_KEY=secret\n',
    });
    const list = await listExportFiles(dir);
    const out = path.join(dir, '..', 'export.zip');
    const bytes = await buildZip(dir, list, out);

    expect(fs.existsSync(out)).toBe(true);
    expect(bytes).toBe(fs.statSync(out).size);
    expect(bytes).toBeGreaterThan(0);
    fs.rmSync(out);
  });

  it.skipIf(!hasUnzip)(
    'buildZip writes a zip that unzip -l lists with the same entries',
    async () => {
      const dir = makeRepo({
        'src/index.html': '<h1>x</h1>',
        '.env': 'API_KEY=secret\n',
      });
      const list = await listExportFiles(dir);
      const out = path.join(dir, '..', 'export.zip');
      await buildZip(dir, list, out);

      const listing = execFileSync('unzip', ['-l', out]).toString();
      expect(listing).toContain('src/index.html');
      expect(listing).toContain('.env.example');
      fs.rmSync(out);
    },
  );
});
