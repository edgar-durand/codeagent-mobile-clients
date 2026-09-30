import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../plugin/openai');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = (p: string) => JSON.parse(read(p)) as Record<string, any>;

describe('plugin/openai package', () => {
  it('manifest has the required listing fields within the portal limits', () => {
    const m = json('plugin.json');
    expect(m.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    expect(m.name).toBe('codeagent-mobile');
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    const i = m.extensions['com.openai'].interface;
    expect(i.displayName.length).toBeLessThanOrEqual(30);
    expect(i.shortDescription.length).toBeLessThanOrEqual(30);
    expect(i.longDescription.length).toBeLessThanOrEqual(4000);
    for (const k of ['category', 'websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL', 'developerName', 'logo', 'composerIcon']) expect(i[k], k).toBeTruthy();
    // Screenshots ship later (Plan 04 Task 3 explicitly defers them — they need
    // the live connector to capture real product screens) so the manifest may
    // omit `screenshots` entirely for now; when present every entry must exist.
    for (const p of [i.logo, i.composerIcon, ...(i.screenshots ?? [])]) { expect(p).toMatch(/^\.\//); expect(fs.existsSync(path.join(ROOT, p)), p).toBe(true); }
    expect(i.capabilities).toEqual(['Read', 'Write']);
  });
  it('.codex-plugin/plugin.json is byte-identical to plugin.json', () => {
    expect(read('.codex-plugin/plugin.json')).toBe(read('plugin.json'));
  });
  it('mcp.json points at the production streamable-http endpoint', () => {
    expect(json('mcp.json')).toEqual({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { 'codeagent-mobile': { type: 'streamable-http', url: 'https://mcp.codeagent-mobile.com/mcp' } } });
  });
  it('every skill has frontmatter name/description and stays under 256 KiB', () => {
    const skills = fs.readdirSync(path.join(ROOT, 'skills'));
    expect(skills.sort()).toEqual(['continue-with-codeagent-credits', 'review-agent-work', 'start-coding-task', 'supervise-session']);
    for (const s of skills) {
      const md = read(`skills/${s}/SKILL.md`);
      expect(md.length).toBeLessThan(256 * 1024);
      const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
      expect(fm).toMatch(new RegExp(`^name: ${s}$`, 'm'));
      expect(fm).toMatch(/^description: .+/m);
    }
  });
  it('no skill tells the model to skip a wallet confirmation', () => {
    for (const s of fs.readdirSync(path.join(ROOT, 'skills'))) expect(read(`skills/${s}/SKILL.md`)).not.toMatch(/confirm_wallet_use:\s*true\s+without/i);
  });
});
