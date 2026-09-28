import fs from 'node:fs';
import path from 'node:path';
import { ZipFile } from 'yazl';
import type { ExportList } from './export-files';

/** Streams `list.files` (plus the generated `.env.example`, if any) from `cwd` into `outFile`. Resolves with bytes written. */
export function buildZip(cwd: string, list: ExportList, outFile: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    for (const f of list.files) {
      const abs = path.join(cwd, f.rel);
      // Re-checked here (lstat, not stat): a path that became a symlink after
      // the list was built is skipped, never followed out of the project.
      if (!fs.lstatSync(abs, { throwIfNoEntry: false })?.isFile()) continue;
      zip.addFile(abs, f.rel);
    }
    if (list.envExample) zip.addBuffer(Buffer.from(list.envExample), '.env.example');
    const out = fs.createWriteStream(outFile, { mode: 0o600 });
    zip.outputStream.pipe(out);
    out.on('close', () => resolve(fs.statSync(outFile).size));
    out.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.end();
  });
}
