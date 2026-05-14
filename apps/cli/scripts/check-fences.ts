import * as fs from 'node:fs';
import { renderCodexBuffer } from '../src/agents/codex/renderer';
import { filterCodexChrome } from '../src/agents/codex/parsing';

const raw = fs.readFileSync('__tests__/fixtures/codex-multiline-reply.bin', 'utf8');
const lines = renderCodexBuffer(raw);
const filtered = filterCodexChrome(lines);
const joined = filtered.join('\n');

console.log('Total fence openers:', (joined.match(/```\w*\n/g) ?? []).length);
console.log('Total fence closers:', (joined.match(/\n```\n/g) ?? []).length);
console.log('Languages detected:', [...new Set((joined.match(/```(\w+)/g) ?? []).map(s => s.slice(3)))].filter(s => s));

// Show first 60 lines of output to see what fenced
filtered.slice(0, 80).forEach((l, i) => {
  const flag = l.startsWith('```') ? ' ⬅️FENCE' : '';
  console.log(`${String(i).padStart(3)}: ${JSON.stringify(l.slice(0, 80))}${flag}`);
});
