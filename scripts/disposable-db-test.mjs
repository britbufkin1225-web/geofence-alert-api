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

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const COMPOSE_PROJECT = 'geofence-gf3-disposable-test';
const COMPOSE_FILE = 'docker-compose.test.yml';
const SERVICE = 'postgis-test';
const CONTAINER = 'geofence-gf3-disposable-postgis';
const PORT = process.env.TEST_DB_PORT ?? '55433';

const DATABASE_URL =
  `postgresql://geofence_test:geofence_test_only_not_a_secret` +
  `@127.0.0.1:${PORT}/geofence_gf3_disposable?schema=public`;

const keepRunning = process.argv.includes('--keep');

function run(command, args, { env, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  });
  return result;
}

function compose(args, options) {
  return run(
    'docker',
    ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, ...args],
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

let tornDown = false;
function teardown() {
  if (tornDown || keepRunning) {
    return;
  }
  tornDown = true;
  step('Cleanup (disposable stack only)');
  // No `-v`: the test database is tmpfs-backed and owns no volume.
  compose(['down', '--remove-orphans']);
}

function waitForHealthy(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inspect = run(
      'docker',
      ['inspect', '-f', '{{.State.Health.Status}}', CONTAINER],
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
if (run('docker', ['info', '--format', '{{.ServerVersion}}'], { capture: true })
  .status !== 0) {
  console.error('Docker daemon is not reachable. Start Docker and retry.');
  process.exit(1);
}

step(`Start disposable PostGIS stack (project ${COMPOSE_PROJECT})`);
// Recreate from scratch so a stale container from a previous run cannot make a
// migration appear to succeed against already-migrated state.
compose(['down', '--remove-orphans']);
if (compose(['up', '-d', '--force-recreate', SERVICE]).status !== 0) {
  fail('could not start the disposable PostGIS container');
}

step('Wait for database health');
if (!waitForHealthy()) {
  compose(['logs', SERVICE]);
  fail('the disposable database never became healthy');
}
console.log(`${CONTAINER} is healthy on 127.0.0.1:${PORT}`);

step('Deploy committed migrations');
if (
  run('npx', ['prisma', 'migrate', 'deploy'], { env: { DATABASE_URL } })
    .status !== 0
) {
  fail('prisma migrate deploy failed');
}

step('Generate Prisma Client');
if (run('npx', ['prisma', 'generate'], { env: { DATABASE_URL } }).status !== 0) {
  fail('prisma generate failed');
}

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
