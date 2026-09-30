#!/usr/bin/env node
// Validates plugin/openai and writes dist/codeagent-mobile-plugin-<version>.zip.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), 'plugin/openai');
const fail = (m) => { console.error(`plugin-pack: ${m}`); process.exit(1); };
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

const manifest = readJson('plugin.json');
if (fs.readFileSync(path.join(root, 'plugin.json'), 'utf8') !== fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'), 'utf8')) fail('.codex-plugin/plugin.json differs from plugin.json');
const ui = manifest.extensions?.['com.openai']?.interface ?? fail('extensions.com.openai.interface missing');
if (ui.displayName.length > 30) fail('displayName > 30 chars');
if (ui.shortDescription.length > 30) fail('shortDescription > 30 chars');
if (ui.longDescription.length > 4000) fail('longDescription > 4000 chars');
for (const k of ['category', 'websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL', 'developerName']) if (!ui[k]) fail(`${k} missing`);
for (const rel of [ui.logo, ui.composerIcon, ...(ui.screenshots ?? [])]) {
  if (!rel.startsWith('./')) fail(`asset path must start with ./: ${rel}`);
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root) || !fs.existsSync(abs)) fail(`asset missing or outside root: ${rel}`);
}
const mcp = readJson('mcp.json');
for (const [name, s] of Object.entries(mcp.mcpServers ?? {})) if (s.type !== 'streamable-http' || !/^https:\/\//.test(s.url)) fail(`mcp server ${name} must be streamable-http over https`);
for (const s of fs.readdirSync(path.join(root, 'skills'))) {
  const md = fs.readFileSync(path.join(root, 'skills', s, 'SKILL.md'), 'utf8');
  if (md.length > 256 * 1024) fail(`skill ${s} > 256 KiB`);
  if (!/^---\n[\s\S]*?^name: /m.test(md) || !/^description: /m.test(md)) fail(`skill ${s} lacks name/description frontmatter`);
}
fs.mkdirSync(path.resolve('dist'), { recursive: true });
const out = path.resolve('dist', `codeagent-mobile-plugin-${manifest.version}.zip`);
fs.rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', out, '.', '-x', '*.DS_Store', 'SUBMISSION.md', 'README.md'], { cwd: root, stdio: 'inherit' });
console.log(`plugin-pack: wrote ${out}`);
