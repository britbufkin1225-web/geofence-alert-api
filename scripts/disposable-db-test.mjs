#!/usr/bin/env node
/**
 * GF-3 disposable PostgreSQL/PostGIS verification.
 *
 * Starts the throwaway PostGIS stack defined in docker-compose.test.yml, waits
 * for it to become healthy, deploys the committed migrations against it, runs
 * the integration suite, and tears the stack down again.
 *
 * Safety properties:
 *   * Every docker command is pinned to the `geofence-gf3-disposable-test`
 *     Compose project and the `docker-compose.test.yml` file, so it cannot act
 *     on the developer stack in docker-compose.yml.
 *   * The teardown is a plain `docker compose down` (no `-v`). The test database
 *     is tmpfs-backed, so there is no volume to remove and none is ever removed.
 *   * DATABASE_URL is constructed here and passed explicitly to the child
 *     processes; an unrelated DATABASE_URL in the developer's environment or
 *     .env can never become the migration target.
 *
 * Usage:
 *   node scripts/disposable-db-test.mjs           # start, migrate, test, clean up
 *   node scripts/disposable-db-test.mjs --keep    # leave the database running
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import identity from './disposable-db-identity.js';
const {
  disposableUrl,
  verifyDisposableDatabase,
  verifyLocalDocker,
  validateContainer,
  docker,
  CONTEXT,
} = identity;

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const COMPOSE_PROJECT = 'geofence-gf3-disposable-test';
const COMPOSE_FILE = 'docker-compose.test.yml';
const SERVICE = 'postgis-test';
const CONTAINER = 'geofence-gf3-disposable-postgis';
const PORT = process.env.TEST_DB_PORT ?? '55433';

const DATABASE_URL = disposableUrl(PORT);

const keepRunning = process.argv.includes('--keep');

function run(command, args, { env, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, TEST_DB_PORT: PORT, ...env },
  });
  return result;
}

function compose(args, options) {
  return run(
    'docker',
    [
      '--context',
      CONTEXT,
      'compose',
      '-p',
      COMPOSE_PROJECT,
      '-f',
      COMPOSE_FILE,
      ...args,
    ],
    options,
  );
}

function step(label) {
  console.log(`\n=== ${label} ===`);
}

function fail(message) {
  console.error(`\nFAILED: ${message}`);
  teardown();
  process.exit(1);
}

function safeDown() {
  verifyLocalDocker();
  // Inspect every project container before any teardown; never remove orphans.
  const ids = docker([
    'ps',
    '-aq',
    '--filter',
    'label=com.docker.compose.project=' + COMPOSE_PROJECT,
  ])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const id of ids) {
    const [container] = JSON.parse(docker(['inspect', id]));
    validateContainer(container, false);
  }
  if (compose(['down']).status !== 0) {
    throw new Error('Disposable cleanup failed; inspect the test stack.');
  }
}

let tornDown = false;
function teardown() {
  if (tornDown || keepRunning) {
    return;
  }
  tornDown = true;
  step('Cleanup (disposable stack only)');
  // No `-v`: the test database is tmpfs-backed and owns no volume.
  safeDown();
}

function waitForHealthy(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inspect = run(
      'docker',
      [
        '--context',
        CONTEXT,
        'inspect',
        '-f',
        '{{.State.Health.Status}}',
        CONTAINER,
      ],
      { capture: true },
    );
    const status = (inspect.stdout ?? '').trim();
    if (status === 'healthy') {
      return true;
    }
    if (status === 'unhealthy') {
      return false;
    }
    // Busy-wait in small slices; the container reports health every 2s.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  return false;
}

process.on('SIGINT', () => {
  teardown();
  process.exit(130);
});

step('Preflight: docker daemon');
if (
  run(
    'docker',
    ['--context', CONTEXT, 'info', '--format', '{{.ServerVersion}}'],
    { capture: true },
  ).status !== 0
) {
  console.error('Docker daemon is not reachable. Start Docker and retry.');
  process.exit(1);
}

step(`Start disposable PostGIS stack (project ${COMPOSE_PROJECT})`);
// Recreate from scratch so a stale container from a previous run cannot make a
// migration appear to succeed against already-migrated state.
safeDown();
if (compose(['up', '-d', '--force-recreate', SERVICE]).status !== 0) {
  fail('could not start the disposable PostGIS container');
}

step('Wait for database health');
if (!waitForHealthy()) {
  compose(['logs', SERVICE]);
  fail('the disposable database never became healthy');
}
console.log(`${CONTAINER} is healthy on 127.0.0.1:${PORT}`);

verifyDisposableDatabase(DATABASE_URL);

step('Deploy committed migrations');
if (
  run('npx', ['prisma', 'migrate', 'deploy'], { env: { DATABASE_URL } })
    .status !== 0
) {
  fail('prisma migrate deploy failed');
}

step('Generate Prisma Client');
if (
  run('npx', ['prisma', 'generate'], { env: { DATABASE_URL } }).status !== 0
) {
  fail('prisma generate failed');
}

step('Verify the exact known Prisma drift');
const drift = run(
  'npx',
  [
    'prisma',
    'migrate',
    'diff',
    '--from-schema',
    'prisma/schema.prisma',
    '--to-config-datasource',
    '--script',
  ],
  { env: { DATABASE_URL }, capture: true },
);
// The one drift Prisma will always report, now once per spatial table. Prisma
// models both geography columns as optional `Unsupported(...)` fields and has no
// concept of a STORED GENERATED column, so it reads the NOT NULL and the
// generation expression (which it sees as a DEFAULT) as missing and offers to
// add them back. PostgreSQL rejects both statements outright. The drift is
// asserted verbatim rather than ignored, so any OTHER divergence -- an unapplied
// migration, a hand-edited database -- still fails the run.
const expectedDrift = [
  '-- AlterTable',
  'ALTER TABLE "public"."Geofence" ALTER COLUMN "centerPoint" SET NOT NULL,',
  'ALTER COLUMN "centerPoint" SET DEFAULT (st_setsrid(st_makepoint(longitude, latitude), 4326))::geography;',
  '',
  '-- AlterTable',
  'ALTER TABLE "public"."LocationEvent" ALTER COLUMN "observedPoint" SET NOT NULL,',
  'ALTER COLUMN "observedPoint" SET DEFAULT (st_setsrid(st_makepoint(longitude, latitude), 4326))::geography;',
].join('\n');
if (
  drift.status !== 0 ||
  (drift.stdout ?? '').replace(/\r\n/g, '\n').trim() !== expectedDrift
) {
  console.error(drift.stdout, drift.stderr);
  fail(
    'unexpected Prisma drift; review the complete diff, never blanket-ignore it',
  );
}
console.log(drift.stdout.trim());

step('Run integration suite against the disposable database');
const tests = run(
  'npx',
  ['jest', '--config', './test/jest-integration.json', '--runInBand'],
  { env: { DATABASE_URL, NODE_ENV: 'test' } },
);

teardown();

if (tests.status !== 0) {
  console.error('\nIntegration suite failed.');
  process.exit(tests.status ?? 1);
}

console.log('\nDisposable PostgreSQL/PostGIS verification passed.');
