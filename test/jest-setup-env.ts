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
