import { verifyDisposableDatabase } from '../../../scripts/disposable-db-identity';
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

export function requireDisposableDatabaseUrl(): string {
  return verifyDisposableDatabase(process.env.DATABASE_URL);
}

/**
 * Empties every table between suites. Identifiers are static literals — no
 * value here comes from test input or the environment.
 */
export async function truncateAll(prisma: PrismaService): Promise<void> {
  requireDisposableDatabaseUrl();
  await prisma.$executeRaw`TRUNCATE TABLE "LocationEvent", "TrackedDevice", "AlertEvent", "Geofence", "Membership", "User", "Tenant" RESTART IDENTITY CASCADE`;
}

export function createPrismaService(): PrismaService {
  requireDisposableDatabaseUrl();
  return new PrismaService();
}
