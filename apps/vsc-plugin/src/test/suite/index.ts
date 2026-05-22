/**
 * Mocha runner loaded by VS Code via `--extensionTestsPath`. Loaded
 * INSIDE the spawned VS Code process — `vscode` and the activated
 * extension are both available via `require('vscode')` from any test
 * file picked up by the glob below.
 */

import * as path from 'node:path';
import { glob } from 'glob';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: false,
    timeout: 60_000,
  });

  const testsRoot = path.resolve(__dirname);

  return new Promise((resolve, reject) => {
    glob('**/*.test.js', { cwd: testsRoot })
      .then((files) => {
        for (const f of files) {
          mocha.addFile(path.resolve(testsRoot, f));
        }
        try {
          mocha.run((failures) => {
            if (failures > 0) {
              reject(new Error(`${failures} test(s) failed.`));
            } else {
              resolve();
            }
          });
        } catch (err) {
          reject(err);
        }
      })
      .catch(reject);
  });
}
