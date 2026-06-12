import { describe, expect, it } from 'vitest';
import {
  detectServicesFromDeps,
  renderComposeYaml,
  pickMigrationScript,
} from '../../src/services/preview/provision-deps';

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
