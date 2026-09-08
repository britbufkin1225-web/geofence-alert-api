import { PrismaService } from '../../../src/prisma/prisma.service';

/**
 * Shared bootstrap for the GF-3 integration suite.
 *
 * These tests run destructive statements (TRUNCATE) and are the only tests that
 * touch a real server, so the guard below refuses to run against anything that
 * is not the disposable database provisioned by docker-compose.test.yml. A
 * developer who runs `npm run test:integration` with their own DATABASE_URL
 * exported gets a clear failure instead of a wiped development database.
 */

// Set by docker-compose.test.yml / scripts/disposable-db-test.mjs.
const DISPOSABLE_DATABASE_NAME = 'geofence_gf3_disposable';

export function requireDisposableDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;

  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    throw new Error(
      'Integration tests require a PostgreSQL DATABASE_URL. Run them via ' +
        '`npm run test:db`, which provisions the disposable PostGIS database.',
    );
  }

  let databaseName: string;
  try {
    databaseName = new URL(url).pathname.replace(/^\//, '');
  } catch {
    throw new Error('DATABASE_URL is not a parseable connection string.');
  }

  if (databaseName !== DISPOSABLE_DATABASE_NAME) {
    throw new Error(
      `Refusing to run destructive integration tests against database ` +
        `"${databaseName}". They only run against the disposable database ` +
        `"${DISPOSABLE_DATABASE_NAME}" (see docker-compose.test.yml). Use ` +
        '`npm run test:db`.',
    );
  }

  return url;
}

/**
 * Empties every table between suites. Identifiers are static literals — no
 * value here comes from test input or the environment.
 */
export async function truncateAll(prisma: PrismaService): Promise<void> {
  await prisma.$executeRaw`TRUNCATE TABLE "AlertEvent", "Geofence", "Membership", "User", "Tenant" RESTART IDENTITY CASCADE`;
}

export function createPrismaService(): PrismaService {
  requireDisposableDatabaseUrl();
  return new PrismaService();
}
