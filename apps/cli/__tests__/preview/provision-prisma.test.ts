import { describe, it, expect } from 'vitest';
import {
  prismaProvider,
  serviceForPrismaProvider,
  detectServicesFromDeps,
} from '../../src/services/preview/provision-deps';

/**
 * ⚠️ **Prisma no aparece en `package.json` como driver.**
 *
 * Un proyecto Prisma trae `@prisma/client`, no `pg` ni `mysql2`, así que
 * `detectServicesFromDeps` no le veía NINGUNA base de datos y no se le
 * provisionaba nada — aunque Docker estuviera perfecto. El dev server arrancaba
 * sin BD y moría con un error del framework, y el usuario no tenía forma de
 * saber qué le faltaba (replay de PostHog, 2026-08-29).
 *
 * El proveedor real vive en el bloque `datasource` del propio esquema.
 */
describe('prismaProvider', () => {
  it('lee el proveedor del datasource', () => {
    expect(
      prismaProvider(`
        generator client { provider = "prisma-client-js" }
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }
      `),
    ).toBe('postgresql');
  });

  /**
   * ⚠️ El bloque `generator` también tiene un `provider`, y va ANTES. Una
   * expresión que no se anclara en `datasource` leería
   * `prisma-client-js` y no levantaría ninguna base de datos.
   */
  it('NO confunde el provider del generator con el del datasource', () => {
    const p = prismaProvider(`
      generator client { provider = "prisma-client-js" }
      datasource db { provider = "mysql" url = env("DATABASE_URL") }
    `);
    expect(p).toBe('mysql');
  });

  it('el bloque puede llamarse como sea', () => {
    expect(prismaProvider('datasource miBase {\n provider = "mongodb"\n}')).toBe('mongodb');
  });

  it('un esquema sin datasource no inventa nada', () => {
    expect(prismaProvider('generator client { provider = "prisma-client-js" }')).toBeNull();
  });
});

describe('serviceForPrismaProvider', () => {
  it('mapea los proveedores a su servicio', () => {
    expect(serviceForPrismaProvider('postgresql')?.name).toBe('postgres');
    expect(serviceForPrismaProvider('postgres')?.name).toBe('postgres');
    expect(serviceForPrismaProvider('mysql')?.name).toBe('mysql');
    expect(serviceForPrismaProvider('mongodb')?.name).toBe('mongo');
  });

  // PlanetScale habla el protocolo de MySQL, así que un MySQL local sirve.
  it('planetscale se sirve con MySQL', () => {
    expect(serviceForPrismaProvider('planetscale')?.name).toBe('mysql');
  });

  /**
   * ⚠️ `sqlite` es un FICHERO. Levantarle un contenedor sería inventar un
   * problema, y contarlo como «falta» mandaría al usuario a rellenar una
   * variable que no necesita.
   */
  it('sqlite no necesita contenedor', () => {
    expect(serviceForPrismaProvider('sqlite')).toBeNull();
    expect(serviceForPrismaProvider(null)).toBeNull();
  });
});

describe('detectServicesFromDeps — lo que ya cubría', () => {
  it('sigue reconociendo los drivers directos', () => {
    expect(detectServicesFromDeps({ dependencies: { pg: '8' } }).map((s) => s.name)).toEqual([
      'postgres',
    ]);
    expect(
      detectServicesFromDeps({ dependencies: { ioredis: '5' } }).map((s) => s.name),
    ).toEqual(['redis']);
  });

  // Y esta es la prueba de que el hueco existía: un proyecto Prisma puro no
  // trae ningún driver, así que por aquí no se detecta nada.
  it('un proyecto Prisma puro no declara ningún driver', () => {
    expect(detectServicesFromDeps({ dependencies: { '@prisma/client': '5' } })).toEqual([]);
  });
});
