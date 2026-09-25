import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MCP_SECRETS_FILE_ENV,
  loadMcpSecrets,
  mcpSecretEnv,
  writeMcpSecrets,
} from '../../src/integrations/mcp-secrets';

/**
 * codeagent-5bew: MCP credentials travel in an owner-only file, never in the
 * env the ACP adapter copies onto the agent's argv.
 */
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-secrets-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('mcp secrets file', () => {
  it('is owner-only and a write REPLACES the file (no stale credential lingers)', () => {
    const file = path.join(dir, `${process.pid}-integrations.json`);
    writeMcpSecrets({ A: '1', B: '2' }, file);
    writeMcpSecrets({ A: '3' }, file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ A: '3' });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('prunes files left by processes that no longer exist', () => {
    const stale = path.join(dir, '999999-preview.json');
    fs.writeFileSync(stale, '{}');
    writeMcpSecrets({ A: '1' }, path.join(dir, `${process.pid}-integrations.json`));
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('the env entry is only the path; loading fills values without overriding explicit ones', () => {
    const entries = mcpSecretEnv('preview', { TOKEN: 'shh' });
    expect(JSON.stringify(entries)).not.toContain('shh');
    const env: NodeJS.ProcessEnv = Object.fromEntries(entries.map((e) => [e.name, e.value]));
    expect(env[MCP_SECRETS_FILE_ENV]).toBeTruthy();
    loadMcpSecrets(env);
    expect(env.TOKEN).toBe('shh');
    const explicit: NodeJS.ProcessEnv = { ...env, TOKEN: 'override' };
    loadMcpSecrets(explicit);
    expect(explicit.TOKEN).toBe('override');
  });

  it('an unreadable or missing file is a no-op', () => {
    const env: NodeJS.ProcessEnv = { [MCP_SECRETS_FILE_ENV]: path.join(dir, 'nope.json') };
    expect(() => loadMcpSecrets(env)).not.toThrow();
  });
});
