const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * node-pty ships pre-compiled native bindings (`pty.node` + `spawn-helper`) in
 * `node_modules/node-pty/prebuilds/<platform>-<arch>/`. esbuild bundles
 * node-pty's JavaScript but cannot copy native `.node` files. The bundled
 * `dist/extension.js` resolves `require('./prebuilds/<platform>-<arch>/pty.node')`
 * relative to its own location, so we must mirror the prebuilds tree into
 * `dist/prebuilds/` before packaging.
 *
 * Both v2.15.2 and v2.15.3 shipped to the marketplace without this copy step
 * and crashed at activation with "Failed to load native module: pty.node".
 * This is the missing post-build hook.
 *
 * The copy includes all platforms shipped by node-pty (darwin-{arm64,x64},
 * win32-{arm64,x64}, linux-x64, etc.) so the same .vsix runs on every
 * platform the marketplace serves.
 */
function copyNodePtyPrebuilds() {
  // npm hoists node-pty to the workspace root, so resolving from
  // `apps/vsc-plugin/node_modules/node-pty/` fails when the install is
  // hoisted. Use `require.resolve` against node-pty's package.json — that
  // gives the real install location regardless of hoisting layout.
  const ptyPackageJson = require.resolve('node-pty/package.json', {
    paths: [__dirname],
  });
  const src = path.join(path.dirname(ptyPackageJson), 'prebuilds');
  const dest = path.join(__dirname, 'dist', 'prebuilds');

  if (!fs.existsSync(src)) {
    throw new Error(
      `node-pty prebuilds not found at ${src}. node-pty may have been installed without prebuilt binaries — run \`npm install --foreground-scripts\` from the workspace root.`,
    );
  }

  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });

  // node-pty 1.1.0 only ships darwin/win32 prebuilds — Linux has no
  // shipped binary, so the prebuilds copy above never produces a
  // `linux-<arch>/pty.node`. On a Linux runner (CI E2E, or a Linux
  // contributor packaging locally), `npm rebuild node-pty` compiles
  // `pty.node` into `node-pty/build/Release/`. Mirror it into the
  // matching `prebuilds/<platform>-<arch>/` so the bundled extension
  // can resolve it at the same path it uses everywhere else.
  const localRelease = path.join(path.dirname(ptyPackageJson), 'build', 'Release');
  const localPty = path.join(localRelease, 'pty.node');
  if (fs.existsSync(localPty)) {
    const platDir = path.join(dest, `${process.platform}-${process.arch}`);
    fs.mkdirSync(platDir, { recursive: true });
    fs.cpSync(localPty, path.join(platDir, 'pty.node'));
    const spawnHelper = path.join(localRelease, 'spawn-helper');
    if (fs.existsSync(spawnHelper)) {
      fs.cpSync(spawnHelper, path.join(platDir, 'spawn-helper'));
    }
    console.log(
      `[esbuild] copied locally-built node-pty → dist/prebuilds/${process.platform}-${process.arch}`,
    );
  }

  const platforms = fs.readdirSync(dest);
  console.log(`[esbuild] copied node-pty prebuilds → dist/prebuilds (${platforms.join(', ')})`);
}

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'info',
    mainFields: ['module', 'main'],
  });

  if (watch) {
    // In watch mode, copy prebuilds once at startup so the dev sandbox has
    // them. Subsequent rebuilds don't touch them — node-pty isn't something
    // the developer is editing.
    copyNodePtyPrebuilds();
    await ctx.watch();
    console.log('Watching for changes...');
  } else {
    await ctx.rebuild();
    copyNodePtyPrebuilds();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
