/**
 * Test-only environment bootstrap. Runs before any module is imported so that
 * ConfigModule's fail-closed validation has the authentication secret it
 * requires. This deterministic value exists ONLY for the test process and is
 * never used by the runtime (main.ts reads real configuration/environment).
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET ?? 'test-only-jwt-secret-value-not-used-in-production';
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '1h';

/**
 * The unit/HTTP suite replaces PrismaService with a mock and never opens a
 * connection, but ConfigModule still validates DATABASE_URL at module init.
 * This placeholder satisfies that validation without pointing at a real server.
 * Integration tests set a genuine DATABASE_URL for the disposable PostGIS
 * database and therefore keep whatever value is already in the environment.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://unit-tests:unit-tests@127.0.0.1:1/unit_tests_never_connected?schema=public';
