#!/usr/bin/env node
/**
 * Vendor a slim copy of `node-pty` into dist/vendor/ at build time.
 *
 * Why we vendor instead of declaring it as a (regular or optional)
 * dependency:
 *
 * 1. node-pty 1.0.0 ships zero Windows prebuilds, and `^1.x` lets
 *    npm fall back to 1.0.0 in some environments → users get a
 *    half-installed package with no `conpty.node`.
 * 2. As an `optionalDependency`, npm silently skips the install on
 *    any failure → users see runtime "Cannot find module" errors
 *    long after `npm install -g codeam-cli` reports success.
 * 3. As a regular dependency, Linux users would fail because
 *    node-pty 1.1.0 only ships darwin/win32 prebuilds.
 *
 * Vendoring the parts we actually need into our own dist folder
 * sidesteps all three. The codeam-cli tarball ships pre-extracted
 * with a working ConPTY binary; the user's npm just unpacks our
 * tarball, no native install resolution involved.
 *
 * What we copy:
 *   - lib/                 the Windows-side JS (unixTerminal stays
 *                          unused on Mac/Linux because UnixPtyStrategy
 *                          uses our Python helper, not node-pty)
 *   - package.json         so `require('./vendor/node-pty')` resolves
 *   - prebuilds/win32-x64
 *   - prebuilds/win32-arm64
 *
 * What we skip:
 *   - prebuilds/darwin-*   — Mac uses UnixPtyStrategy
 *   - *.pdb                — Windows debug symbols, ~27 MB unused
 *   - *.test.js / *.map    — dev-only artifacts
 */

const fs = require('fs');
const path = require('path');

// Resolve node-pty regardless of npm's hoisting decisions. In a
// monorepo, npm tends to lift workspace devDeps into the root
// node_modules/, so apps/cli/node_modules/node-pty/ won't always
// exist. require.resolve() asks Node where the package actually is.
let SRC;
try {
  SRC = path.dirname(require.resolve('node-pty/package.json'));
} catch (err) {
  console.error(
    '[vendor-node-pty] node-pty not resolvable.\n' +
      '  Run `npm install` at the repo root before building so the ' +
      'devDependency is present.',
  );
  process.exit(1);
}
const DST = path.resolve(__dirname, '..', 'dist', 'vendor', 'node-pty');

function shouldSkip(filename) {
  return (
    filename.endsWith('.pdb') ||
    filename.endsWith('.test.js') ||
    filename.endsWith('.test.js.map') ||
    filename.endsWith('.map')
  );
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sPath = path.join(src, entry.name);
    const dPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyTree(sPath, dPath);
    } else if (entry.isFile() && !shouldSkip(entry.name)) {
      fs.copyFileSync(sPath, dPath);
    }
  }
}

fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });

// Top-level package.json — needed so node treats the vendor dir as a
// CommonJS package and `require('./vendor/node-pty')` resolves through
// its `main` field.
fs.copyFileSync(path.join(SRC, 'package.json'), path.join(DST, 'package.json'));

// Library JS
copyTree(path.join(SRC, 'lib'), path.join(DST, 'lib'));

// Windows prebuilds (and only Windows — see header).
const prebuilds = path.join(SRC, 'prebuilds');
if (fs.existsSync(prebuilds)) {
  for (const arch of ['win32-x64', 'win32-arm64']) {
    const archSrc = path.join(prebuilds, arch);
    if (fs.existsSync(archSrc)) {
      copyTree(archSrc, path.join(DST, 'prebuilds', arch));
    }
  }
}

// Print a tiny manifest so build logs make it obvious what shipped.
const totalBytes = (function dirSize(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    if (e.isDirectory()) total += dirSize(f);
    else total += fs.statSync(f).size;
  }
  return total;
})(DST);
console.log(
  `[vendor-node-pty] Copied to dist/vendor/node-pty/ (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`,
);
