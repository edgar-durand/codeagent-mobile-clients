import * as fs from 'node:fs';
import { renderToLines } from '@codeagent/shared';
import { renderCodexBuffer } from '../src/agents/codex/renderer';
import { filterCodexChrome } from '../src/agents/codex/parsing';

const raw = fs.readFileSync('__tests__/fixtures/codex-multiline-reply.bin', 'utf8');

const sharedLines = renderToLines(raw);
const codexLines = renderCodexBuffer(raw);

console.log('=== SHARED renderer ===');
console.log('  total lines:', sharedLines.length);
const sharedFiltered = filterCodexChrome(sharedLines);
console.log('  after filterCodexChrome:', sharedFiltered.length);
console.log('  content lines:');
sharedFiltered.filter(l => l.trim()).forEach((l, i) => console.log(`    [${i}] ${JSON.stringify(l.slice(0, 100))}`));

console.log();
console.log('=== CODEX renderer ===');
console.log('  total lines:', codexLines.length);
const codexFiltered = filterCodexChrome(codexLines);
console.log('  after filterCodexChrome:', codexFiltered.length);
console.log('  content lines:');
codexFiltered.filter(l => l.trim()).forEach((l, i) => console.log(`    [${i}] ${JSON.stringify(l.slice(0, 100))}`));
