import { describe, expect, it, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as runSetup from '../../src/services/preview/run-setup';
import {
  detectServicesFromDeps,
  renderComposeYaml,
  pickMigrationScript,
  provisionProjectDependencies,
} from '../../src/services/preview/provision-deps';

describe('provisionProjectDependencies — OOM resource discipline', () => {
  afterEach(() => vi.restoreAllMocks());

  it('runs `docker compose up` via nice + ionice (idle priority) when a compose file exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
    fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services: {}\n');
    const calls: string[][] = [];
    vi.spyOn(runSetup, 'runSetupCommand').mockImplementation(async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 'ok', code: 0 };
    });

    await provisionProjectDependencies(dir);

    // The compose-up MUST be wrapped so a cold image pull can't starve the
    // agent (belt-and-suspenders on top of the agent-spawn gate).
    const composeUp = calls.find((c) => c.includes('compose') && c.includes('up'));
    expect(composeUp?.[0]).toBe('nice');
    expect(composeUp).toEqual(
      expect.arrayContaining([
        'nice', '-n', '19', 'ionice', '-c', '3', 'docker', 'compose', 'up', '-d',
      ]),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips provisioning entirely when docker is not usable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
    fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services: {}\n');
    const spy = vi
      .spyOn(runSetup, 'runSetupCommand')
      .mockResolvedValue({ status: 'failed', code: 1 }); // `docker info` fails

    await provisionProjectDependencies(dir);

    /**
     * ⚠️ Lo que importa es que NO se siga con el compose, no cuántas llamadas
     * hubo. Antes se afirmaba «exactamente 1» y eso se rompió en cuanto se
     * añadieron los intentos de ARRANCAR el demonio — que es justo lo que hay
     * que hacer antes de rendirse: en un codespace o un self-hosted recién
     * levantado, lo normal es que Docker esté instalado y parado, no ausente.
     *
     * Contar llamadas fija el número de pasos; lo que hay que fijar es que no
     * se intente levantar servicios sobre un Docker que no responde.
     */
    const argvs = spy.mock.calls.map((c) => [c[0], ...(c[1] as string[])].join(' '));
    expect(argvs.some((a) => a.includes('compose'))).toBe(false);
    expect(argvs[0]).toContain('docker info');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('detectServicesFromDeps', () => {
  it('maps pg + ioredis to postgres + redis', () => {
    const svcs = detectServicesFromDeps({ dependencies: { pg: '^8', ioredis: '^5' } });
    expect(svcs.map((s) => s.name).sort()).toEqual(['postgres', 'redis']);
  });

  it('de-dupes when several drivers pull the same service (typeorm + @nestjs/typeorm + pg → one postgres)', () => {
    const svcs = detectServicesFromDeps({
      dependencies: { typeorm: '^0.3', '@nestjs/typeorm': '^11', pg: '^8', ioredis: '^5' },
    });
    expect(svcs.map((s) => s.name)).toEqual(['postgres', 'redis']);
  });

  it('detects mysql and mongo from their drivers', () => {
    expect(detectServicesFromDeps({ dependencies: { mysql2: '^3' } }).map((s) => s.name)).toEqual([
      'mysql',
    ]);
    expect(detectServicesFromDeps({ dependencies: { mongoose: '^8' } }).map((s) => s.name)).toEqual([
      'mongo',
    ]);
  });

  it('counts devDependencies and returns [] for projects with no known service deps', () => {
    expect(
      detectServicesFromDeps({ devDependencies: { ioredis: '^5' } }).map((s) => s.name),
    ).toEqual(['redis']);
    expect(detectServicesFromDeps({ dependencies: { express: '^4', lodash: '^4' } })).toEqual([]);
  });
});

describe('renderComposeYaml', () => {
  it('renders a healthcheck\'d service block with image + published port', () => {
    const yaml = renderComposeYaml(detectServicesFromDeps({ dependencies: { pg: '^8' } }));
    expect(yaml).toContain('services:');
    expect(yaml).toContain('image: postgres:16');
    expect(yaml).toContain('"5432:5432"');
    expect(yaml).toContain('healthcheck:');
    expect(yaml).toContain('pg_isready');
  });

  it('renders one block per service', () => {
    const yaml = renderComposeYaml(
      detectServicesFromDeps({ dependencies: { pg: '^8', ioredis: '^5' } }),
    );
    expect(yaml).toContain('postgres:');
    expect(yaml).toContain('redis:');
    expect(yaml).toContain('image: redis:7');
  });
});

describe('pickMigrationScript', () => {
  it('prefers migration:run', () => {
    expect(pickMigrationScript({ 'migration:run': 'typeorm migration:run', build: 'tsc' })).toBe(
      'migration:run',
    );
  });

  it('picks db:migrate / migrate:deploy from the preferred list', () => {
    expect(pickMigrationScript({ 'db:migrate': 'knex migrate:latest' })).toBe('db:migrate');
    expect(pickMigrationScript({ 'migrate:deploy': 'prisma migrate deploy' })).toBe('migrate:deploy');
  });

  it('falls back to a *migrat*+run/deploy/latest script', () => {
    expect(pickMigrationScript({ 'typeorm:migration:run': 'x', lint: 'eslint' })).toBe(
      'typeorm:migration:run',
    );
  });

  it('never runs generate/create/revert/rollback scripts', () => {
    expect(
      pickMigrationScript({
        'migration:generate': 'x',
        'migration:revert': 'y',
        'migrate:rollback': 'z',
      }),
    ).toBeNull();
  });

  it('returns null when there is no migration script', () => {
    expect(pickMigrationScript({ build: 'tsc', start: 'node dist' })).toBeNull();
  });
});
