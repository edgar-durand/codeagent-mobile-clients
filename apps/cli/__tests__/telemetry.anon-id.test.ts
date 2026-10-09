import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// An anon.json baked into the Box image was copied into every box home, and
// the one shared id merged unrelated users into a single PostHog person.
const env = vi.hoisted(() => ({ home: '', host: '' }));
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>();
  return { ...real, homedir: () => env.home, hostname: () => env.host };
});

async function readAnonIdOn(host: string): Promise<string> {
  env.host = host;
  vi.resetModules();
  return (await import('../src/services/telemetry.service')).readAnonId();
}

describe('telemetry anon id', () => {
  beforeEach(async () => {
    const realOs = await vi.importActual<typeof import('node:os')>('node:os');
    env.home = fs.mkdtempSync(path.join(realOs.tmpdir(), 'anon-'));
  });
  afterEach(() => {
    fs.rmSync(env.home, { recursive: true, force: true });
  });

  it('keeps the id across runs on the same host', async () => {
    const first = await readAnonIdOn('box-a');
    expect(await readAnonIdOn('box-a')).toBe(first);
  });

  it('mints a new id when the file was written on another host (image-baked)', async () => {
    const baked = await readAnonIdOn('image-builder');
    const onBox = await readAnonIdOn('box-b');
    expect(onBox).not.toBe(baked);
    expect(JSON.parse(fs.readFileSync(path.join(env.home, '.codeam', 'anon.json'), 'utf8'))).toEqual({
      id: onBox,
      host: 'box-b',
    });
  });

  it('replaces a legacy file with no host', async () => {
    fs.mkdirSync(path.join(env.home, '.codeam'));
    fs.writeFileSync(path.join(env.home, '.codeam', 'anon.json'), JSON.stringify({ id: 'anon-shared' }));
    expect(await readAnonIdOn('box-c')).not.toBe('anon-shared');
  });
});
