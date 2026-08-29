import { promises as fs } from 'fs';
import path from 'path';
import { log } from '../logger';
import { runSetupCommand, type SetupRunResult } from './run-setup';

/**
 * Auto-provision a project's runtime dependencies (Postgres, Redis, …) inside
 * a codespace so its dev server boots on the first preview without manual
 * setup. See docs/superpowers/specs/2026-06-12-codespace-auto-provision-
 * project-deps-design.md.
 *
 * Strategy (per repo): compose-first → heuristic generation → `.env` → best-
 * effort migrations. Strictly best-effort + non-fatal — any failure degrades
 * to the preview error-UX (`preview_failed`), never blocks pairing or the
 * agent. Invoked fire-and-forget from the codespace bootstrap.
 */

const COMPOSE_FILES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yaml',
  'compose.yml',
];
const ENV_SAMPLES = ['.env.example', '.env.sample', '.env.local.example', '.env.template'];

interface ServiceSpec {
  name: string;
  image: string;
  port: number;
  environment: Record<string, string>;
  /** Compose healthcheck test argv, so `up -d --wait` blocks until ready. */
  healthTest: string[];
  /** Lines appended to a generated `.env` (connection strings → localhost). */
  envLines: string[];
}

const POSTGRES: ServiceSpec = {
  name: 'postgres',
  image: 'postgres:16',
  port: 5432,
  environment: { POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'postgres', POSTGRES_DB: 'app' },
  healthTest: ['CMD-SHELL', 'pg_isready -U postgres'],
  envLines: [
    'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app',
    'DB_HOST=localhost',
    'DB_PORT=5432',
    'DB_USERNAME=postgres',
    'DB_PASSWORD=postgres',
    'DB_NAME=app',
  ],
};
const MYSQL: ServiceSpec = {
  name: 'mysql',
  image: 'mysql:8',
  port: 3306,
  environment: { MYSQL_ROOT_PASSWORD: 'mysql', MYSQL_DATABASE: 'app' },
  healthTest: ['CMD', 'mysqladmin', 'ping', '-h', 'localhost', '-pmysql'],
  envLines: ['DATABASE_URL=mysql://root:mysql@localhost:3306/app'],
};
const MONGO: ServiceSpec = {
  name: 'mongo',
  image: 'mongo:7',
  port: 27017,
  environment: {},
  healthTest: ['CMD', 'mongosh', '--eval', 'db.adminCommand("ping")'],
  envLines: ['MONGODB_URI=mongodb://localhost:27017/app', 'MONGO_URL=mongodb://localhost:27017/app'],
};
const REDIS: ServiceSpec = {
  name: 'redis',
  image: 'redis:7',
  port: 6379,
  environment: {},
  healthTest: ['CMD', 'redis-cli', 'ping'],
  envLines: ['REDIS_URL=redis://localhost:6379', 'REDIS_HOST=localhost', 'REDIS_PORT=6379'],
};

/**
 * Map a project's package.json dependencies to the backing services it needs.
 * Pure + exported for tests. De-dupes (one service even if several drivers
 * pull it in) and is conservative (only well-known drivers).
 */
/**
 * El proveedor de base de datos que declara un `schema.prisma`.
 *
 * ⚠️ **Prisma no aparece en `package.json` como driver.** Un proyecto Prisma
 * trae `@prisma/client`, no `pg` ni `mysql2`, así que `detectServicesFromDeps`
 * no le veía NINGUNA base de datos y no se le provisionaba nada — aunque
 * Docker estuviera perfecto. El dev server arrancaba sin BD y moría, y el
 * usuario no tenía forma de saber por qué (replay de PostHog, 2026-08-29).
 *
 * El proveedor real vive en el propio esquema, en el bloque `datasource`.
 */
/** Lee el `schema.prisma` del proyecto, en los sitios donde Prisma lo busca. */
export async function readPrismaProvider(cwd: string): Promise<string | null> {
  for (const rel of ['prisma/schema.prisma', 'schema.prisma', 'src/prisma/schema.prisma']) {
    try {
      return prismaProvider(await fs.readFile(path.join(cwd, rel), 'utf8'));
    } catch {
      // Ese sitio no lo tiene; se prueba el siguiente.
    }
  }
  return null;
}

export function prismaProvider(schema: string): string | null {
  // `datasource db { provider = "postgresql" … }` — el bloque puede tener
  // cualquier nombre y el orden de sus campos no está fijado.
  const m = /datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"([^"]+)"/s.exec(schema);
  return m ? m[1] : null;
}

/** Del proveedor de Prisma al servicio que hay que levantar. */
export function serviceForPrismaProvider(provider: string | null): ServiceSpec | null {
  switch (provider) {
    case 'postgresql':
    case 'postgres':
      return POSTGRES;
    case 'mysql':
    // PlanetScale habla el protocolo de MySQL.
    case 'planetscale':
      return MYSQL;
    case 'mongodb':
      return MONGO;
    // `sqlite` es un FICHERO: no necesita contenedor y no es un hueco.
    default:
      return null;
  }
}

export function detectServicesFromDeps(pkg: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): ServiceSpec[] {
  const deps = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  const has = (...names: string[]): boolean => names.some((n) => deps.has(n));
  const out: ServiceSpec[] = [];
  if (has('pg', 'typeorm', '@nestjs/typeorm', 'sequelize', 'postgres', 'postgres.js', 'pg-promise'))
    out.push(POSTGRES);
  if (has('mysql', 'mysql2')) out.push(MYSQL);
  if (has('mongoose', 'mongodb')) out.push(MONGO);
  if (has('ioredis', 'redis', 'cache-manager-ioredis-yet', 'cache-manager-redis-store'))
    out.push(REDIS);
  return out;
}

/** Render a minimal, healthcheck'd compose file for the detected services. */
export function renderComposeYaml(services: ServiceSpec[]): string {
  const blocks = services.map((s) => {
    const env = Object.entries(s.environment);
    const envYaml = env.length
      ? '    environment:\n' + env.map(([k, v]) => `      ${k}: "${v}"`).join('\n') + '\n'
      : '';
    const health = JSON.stringify(s.healthTest);
    return (
      `  ${s.name}:\n` +
      `    image: ${s.image}\n` +
      `    restart: unless-stopped\n` +
      `    ports:\n      - "${s.port}:${s.port}"\n` +
      envYaml +
      `    healthcheck:\n` +
      `      test: ${health}\n` +
      `      interval: 5s\n      timeout: 3s\n      retries: 12\n`
    );
  });
  return `# Generated by codeam — auto-provisioned project dependencies.\n` +
    `# Do not edit; regenerated on each provision. See .codeam/provision/.\n` +
    `services:\n${blocks.join('')}`;
}

/** First migration npm-script that RUNS (not generates) migrations, or null. */
export function pickMigrationScript(scripts: Record<string, string>): string | null {
  const preferred = [
    'migration:run',
    'db:migrate',
    'migrate:deploy',
    'migrate:latest',
    'migrate:up',
    'prisma:migrate',
    'migrate',
  ];
  for (const k of preferred) if (scripts[k]) return k;
  // Fallback: any "*migrat*" script that clearly RUNS migrations and is not a
  // generate/create/rollback/down command.
  for (const k of Object.keys(scripts)) {
    if (
      /migrat/i.test(k) &&
      /(run|deploy|latest|up)/i.test(k) &&
      !/(generate|create|revert|rollback|undo|down|reset|drop)/i.test(k)
    ) {
      return k;
    }
  }
  return null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(cwd: string, names: string[]): Promise<string | null> {
  for (const n of names) if (await exists(path.join(cwd, n))) return n;
  return null;
}

/** Write `.env` from a sample (preferred) or generated lines. Never overwrites. */
async function ensureEnvFile(cwd: string, generated: ServiceSpec[]): Promise<void> {
  if (await exists(path.join(cwd, '.env'))) {
    log.info('provision', '.env already present — leaving it untouched');
    return;
  }
  const sample = await firstExisting(cwd, ENV_SAMPLES);
  if (sample) {
    const body = await fs.readFile(path.join(cwd, sample), 'utf8');
    await fs.writeFile(path.join(cwd, '.env'), body);
    log.info('provision', `wrote .env from ${sample}`);
    return;
  }
  if (generated.length > 0) {
    const body =
      '# Generated by codeam — points at the auto-provisioned local services.\n' +
      generated.flatMap((s) => s.envLines).join('\n') +
      '\n';
    await fs.writeFile(path.join(cwd, '.env'), body);
    log.info('provision', `generated .env for ${generated.map((s) => s.name).join('+')}`);
  }
}

async function readPackageJson(
  cwd: string,
): Promise<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> } | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function runMigrationsIfPresent(cwd: string, scripts: Record<string, string>): Promise<void> {
  const script = pickMigrationScript(scripts);
  if (!script) return;
  log.info('provision', `running migrations: npm run ${script}`);
  const res = await runSetupCommand('npm', ['run', script], cwd, undefined, { timeoutMs: 120_000 });
  if (res.status !== 'ok') log.warn('provision', `migration script "${script}" → ${res.status} (non-fatal)`);
}

/**
 * Run `docker compose` at IDLE cpu+io priority (`nice`/`ionice`) so a cold
 * image pull can't starve the CLI / ACP agent. The agent-spawn gate already
 * sequences the agent AFTER provisioning (no steady overlap) — this is
 * belt-and-suspenders for the tail. Provisioning only runs in a codespace
 * (Linux), where `nice` + `ionice` are always present.
 */
function runDockerComposeUp(cwd: string, composeArgs: string[]): Promise<SetupRunResult> {
  return runSetupCommand(
    'nice',
    ['-n', '19', 'ionice', '-c', '3', 'docker', 'compose', ...composeArgs],
    cwd,
    undefined,
    { timeoutMs: 180_000 },
  );
}

/**
 * Qué necesitaba el proyecto y qué NO se pudo levantar.
 *
 * ⚠️ Antes esto devolvía `void`: provisionar era «mejor esfuerzo» y su fracaso
 * no dejaba rastro que nadie pudiera usar. El resultado era el peor de los
 * mundos — el dev server arrancaba sin base de datos y moría con un error del
 * framework, y el usuario no tenía forma de saber que le faltaba una BD ni qué
 * hacer al respecto.
 *
 * Ahora el fracaso es un dato: quién falta y qué variable de entorno lo
 * resolvería. Con eso el preview puede PROPONER —«pon tu `DATABASE_URL` y
 * relanza»— en vez de morir en silencio. Es el último recurso: lo normal sigue
 * siendo que Docker se lo dé todo.
 */
export interface ProvisionOutcome {
  /** Servicios que el proyecto necesita y no están sirviendo. */
  missing: Array<{ service: string; envVar: string }>;
  /** Por qué, para poder decirlo con palabras. */
  reason: 'ok' | 'no-docker' | 'compose-failed' | 'unknown';
}

/** La variable que el usuario tendría que rellenar por cada servicio. */
function envVarFor(service: ServiceSpec): string {
  // La PRIMERA línea de `envLines` es la principal por construcción
  // (`DATABASE_URL=…`, `REDIS_URL=…`).
  const first = service.envLines[0] ?? '';
  return first.split('=')[0] || 'DATABASE_URL';
}

export async function provisionProjectDependencies(
  cwd: string,
): Promise<ProvisionOutcome> {
  /** Lo que el proyecto necesita, se haya podido levantar o no. */
  let needed: ServiceSpec[] = [];
  const outcome = (reason: ProvisionOutcome['reason']): ProvisionOutcome => ({
    reason,
    missing:
      reason === 'ok'
        ? []
        : needed.map((sv) => ({ service: sv.name, envVar: envVarFor(sv) })),
  });

  try {
    // 1. Docker must be usable (a missing binary or dead daemon → 'failed').
    let docker = await runSetupCommand('docker', ['info'], cwd, undefined, {
      timeoutMs: 15_000,
    });

    /**
     * ⚠️ Un `docker info` que falla NO significa «aquí no hay Docker».
     *
     * El caso más común en un codespace o en un self-hosted recién arrancado
     * es el demonio PARADO, no ausente: el binario está, y basta con
     * levantarlo. Antes se abandonaba en el primer intento y el proyecto se
     * quedaba sin base de datos — con Docker instalado en la máquina.
     *
     * Se intenta con las dos formas que cubren todo lo que usamos (systemd y
     * el `service` de las imágenes sin init), en NO INTERACTIVO (`sudo -n`):
     * un box sin TTY jamás podría contestar a una petición de contraseña, y
     * quedarse colgado ahí sería peor que fallar.
     */
    if (docker.status !== 'ok') {
      log.info('provision', 'docker not responding — trying to start the daemon');
      for (const argv of [
        ['-n', 'systemctl', 'start', 'docker'],
        ['-n', 'service', 'docker', 'start'],
      ]) {
        const started = await runSetupCommand('sudo', argv, cwd, undefined, {
          timeoutMs: 45_000,
        });
        if (started.status !== 'ok') continue;
        docker = await runSetupCommand('docker', ['info'], cwd, undefined, {
          timeoutMs: 20_000,
        });
        if (docker.status === 'ok') {
          log.info('provision', `docker daemon started via ${argv[1]}`);
          break;
        }
      }
    }

    if (docker.status !== 'ok') {
      log.info('provision', 'docker not usable — skipping dependency provisioning');
      // Se mira igualmente QUÉ hacía falta: sin Docker no se puede dar, pero
      // sí se puede decir, que es lo que permite proponer el fallback.
      const pkgForNeeds = await readPackageJson(cwd);
      needed = pkgForNeeds ? detectServicesFromDeps(pkgForNeeds) : [];
      const prismaNeed = serviceForPrismaProvider(await readPrismaProvider(cwd));
      if (prismaNeed && !needed.some((n) => n.name === prismaNeed.name)) {
        needed.push(prismaNeed);
      }
      return outcome('no-docker');
    }

    const pkg = await readPackageJson(cwd);
    let started = false;
    let generated: ServiceSpec[] = [];

    // 2. Compose-first: run what the project author already declared.
    const composeFile = await firstExisting(cwd, COMPOSE_FILES);
    if (composeFile) {
      log.info('provision', `compose found (${composeFile}) — docker compose up -d --wait (idle prio)`);
      const up = await runDockerComposeUp(cwd, ['up', '-d', '--wait']);
      // `--wait` returns non-zero if a service never goes healthy; treat
      // 'ok' as started, but also accept a plain up if --wait isn't honored.
      started = up.status === 'ok';
      if (!started) log.warn('provision', `compose up → ${up.status} (non-fatal)`);
    } else if (pkg) {
      // 3. Heuristic generation when the repo declares no compose.
      generated = detectServicesFromDeps(pkg);

      /**
       * ⚠️ Y lo que Prisma declara en su esquema, que NO está en las
       * dependencias: un proyecto Prisma trae `@prisma/client`, no `pg` ni
       * `mysql2`, así que la heurística de arriba no le veía ninguna base de
       * datos y no se le levantaba nada.
       */
      const prismaSvc = serviceForPrismaProvider(await readPrismaProvider(cwd));
      if (prismaSvc && !generated.some((g) => g.name === prismaSvc.name)) {
        generated.push(prismaSvc);
      }
      needed = generated;
      if (generated.length > 0) {
        const dir = path.join(cwd, '.codeam', 'provision');
        await fs.mkdir(dir, { recursive: true });
        const file = path.join(dir, 'compose.generated.yaml');
        await fs.writeFile(file, renderComposeYaml(generated));
        log.info(
          'provision',
          `no compose in repo — generated ${generated.map((s) => s.name).join('+')}`,
        );
        const up = await runDockerComposeUp(cwd, ['-f', file, 'up', '-d', '--wait']);
        started = up.status === 'ok';
        if (!started) log.warn('provision', `generated compose up → ${up.status} (non-fatal)`);
      } else {
        log.info('provision', 'no compose + no known service deps — nothing to provision');
      }
    }

    // 4. `.env` — from the project's sample (preferred) or generated lines.
    await ensureEnvFile(cwd, generated);

    // 5. Best-effort migrations once services are up.
    if (started && pkg?.scripts) await runMigrationsIfPresent(cwd, pkg.scripts);

    log.info('provision', 'project dependency provisioning complete');
    // `started` es false cuando el compose no llegó a levantar; ahí lo que el
    // proyecto necesita sigue faltando, y decirlo es lo que permite proponer.
    return outcome(needed.length > 0 && !started ? 'compose-failed' : 'ok');
  } catch (err) {
    log.warn('provision', 'provisionProjectDependencies failed (non-fatal)', err);
    return outcome('unknown');
  }
}
