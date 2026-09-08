import { PrismaService } from '../../src/prisma/prisma.service';
import { createPrismaService, truncateAll } from './support/database';

/**
 * Proves the constraints are enforced by PostgreSQL itself, not by the NestJS
 * validation pipe. Every insert here bypasses the API entirely, so a passing
 * test means data written by any future client — a worker, a psql session, a
 * migration — is still bounded.
 *
 * Values are always bound as query parameters; identifiers are static literals.
 */
describe('GF-3 database constraints (disposable PostgreSQL/PostGIS)', () => {
  let prisma: PrismaService;
  let tenantId: string;

  const VALID = {
    latitude: 30.2672,
    longitude: -97.7431,
    radiusMeters: 100,
    name: 'Warehouse Zone',
  };

  /** Raw, parameterized insert that deliberately skips application validation. */
  const insertGeofence = (overrides: {
    id: string;
    tenantId?: string | null;
    name?: string;
    latitude?: number;
    longitude?: number;
    radiusMeters?: number;
  }) =>
    prisma.$executeRaw`
      INSERT INTO "Geofence"
        ("id", "tenantId", "name", "latitude", "longitude", "radiusMeters", "isActive", "createdAt", "updatedAt")
      VALUES (
        ${overrides.id},
        ${overrides.tenantId === undefined ? tenantId : overrides.tenantId},
        ${overrides.name ?? VALID.name},
        ${overrides.latitude ?? VALID.latitude},
        ${overrides.longitude ?? VALID.longitude},
        ${overrides.radiusMeters ?? VALID.radiusMeters},
        true,
        NOW(),
        NOW()
      )
    `;

  beforeAll(async () => {
    prisma = createPrismaService();
    await prisma.$connect();
    await truncateAll(prisma);

    const tenant = await prisma.tenant.create({
      data: { name: 'Constraint Fixture Tenant' },
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await truncateAll(prisma);
    await prisma.$disconnect();
  });

  describe('latitude range', () => {
    it('rejects latitude below -90', async () => {
      await expect(
        insertGeofence({ id: 'lat-too-low', latitude: -90.000001 }),
      ).rejects.toThrow(/Geofence_latitude_range_check/);
    });

    it('rejects latitude above 90', async () => {
      await expect(
        insertGeofence({ id: 'lat-too-high', latitude: 90.000001 }),
      ).rejects.toThrow(/Geofence_latitude_range_check/);
    });

    it('accepts latitude -90 (inclusive boundary)', async () => {
      await expect(
        insertGeofence({ id: 'lat-min', latitude: -90 }),
      ).resolves.toBe(1);
    });

    it('accepts latitude 90 (inclusive boundary)', async () => {
      await expect(
        insertGeofence({ id: 'lat-max', latitude: 90 }),
      ).resolves.toBe(1);
    });
  });

  describe('longitude range', () => {
    it('rejects longitude below -180', async () => {
      await expect(
        insertGeofence({ id: 'lon-too-low', longitude: -180.000001 }),
      ).rejects.toThrow(/Geofence_longitude_range_check/);
    });

    it('rejects longitude above 180', async () => {
      await expect(
        insertGeofence({ id: 'lon-too-high', longitude: 180.000001 }),
      ).rejects.toThrow(/Geofence_longitude_range_check/);
    });

    it('accepts longitude -180 (inclusive boundary)', async () => {
      await expect(
        insertGeofence({ id: 'lon-min', longitude: -180 }),
      ).resolves.toBe(1);
    });

    it('accepts longitude 180 (inclusive boundary)', async () => {
      await expect(
        insertGeofence({ id: 'lon-max', longitude: 180 }),
      ).resolves.toBe(1);
    });
  });

  describe('radius', () => {
    it('rejects a fractional radius below the API minimum', async () => {
      await expect(
        insertGeofence({ id: 'radius-fraction', radiusMeters: 0.5 }),
      ).rejects.toThrow(/Geofence_radiusMeters_positive_check/);
    });
    it('accepts the one metre minimum', async () => {
      await expect(
        insertGeofence({ id: 'radius-min', radiusMeters: 1 }),
      ).resolves.toBe(1);
    });
    it('rejects a zero radius', async () => {
      await expect(
        insertGeofence({ id: 'radius-zero', radiusMeters: 0 }),
      ).rejects.toThrow(/Geofence_radiusMeters_positive_check/);
    });

    it('rejects a negative radius', async () => {
      await expect(
        insertGeofence({ id: 'radius-negative', radiusMeters: -1 }),
      ).rejects.toThrow(/Geofence_radiusMeters_positive_check/);
    });

    it('rejects a radius above the documented maximum', async () => {
      await expect(
        insertGeofence({ id: 'radius-over-max', radiusMeters: 5001 }),
      ).rejects.toThrow(/Geofence_radiusMeters_max_check/);
    });

    it('accepts a valid positive radius', async () => {
      await expect(
        insertGeofence({ id: 'radius-valid', radiusMeters: 100 }),
      ).resolves.toBe(1);
    });

    it('accepts the maximum radius (inclusive boundary)', async () => {
      await expect(
        insertGeofence({ id: 'radius-max', radiusMeters: 5000 }),
      ).resolves.toBe(1);
    });
  });

  describe('required tenant ownership', () => {
    it('rejects a geofence with no owning tenant', async () => {
      await expect(
        insertGeofence({ id: 'no-owner', tenantId: null }),
      ).rejects.toThrow(/null value in column "tenantId"|not-null constraint/i);
    });

    it('rejects a geofence owned by a tenant that does not exist', async () => {
      await expect(
        insertGeofence({
          id: 'bad-owner',
          tenantId: 'ctenantdoesnotexist00000',
        }),
      ).rejects.toThrow(/Geofence_tenantId_fkey|foreign key constraint/i);
    });

    it('accepts a geofence owned by a real tenant', async () => {
      await expect(insertGeofence({ id: 'good-owner' })).resolves.toBe(1);
    });
  });

  describe('required names', () => {
    it.each(['\t\n', '\u00a0\ufeff'])(
      'rejects JavaScript whitespace-only names %s',
      async (name) => {
        await expect(
          insertGeofence({ id: 'blank-unicode', name }),
        ).rejects.toThrow(/Geofence_name_not_blank_check/);
        await expect(prisma.tenant.create({ data: { name } })).rejects.toThrow(
          /Tenant_name_not_blank_check/,
        );
        await expect(
          prisma.user.create({
            data: { email: name + 'a@example.com', passwordHash: 'x' },
          }),
        ).rejects.toThrow(/User_email_not_blank_check/);
      },
    );
    it('rejects a blank geofence name', async () => {
      await expect(
        insertGeofence({ id: 'blank-name', name: '   ' }),
      ).rejects.toThrow(/Geofence_name_not_blank_check/);
    });

    it('rejects a blank tenant name', async () => {
      await expect(
        prisma.tenant.create({ data: { name: '  ' } }),
      ).rejects.toThrow(/Tenant_name_not_blank_check/);
    });

    it('rejects an email with surrounding whitespace', async () => {
      await expect(
        prisma.user.create({
          data: { email: ' spaced@example.com ', passwordHash: 'x' },
        }),
      ).rejects.toThrow(/User_email_not_blank_check/);
    });
  });

  describe('AlertEvent coordinates', () => {
    // Own fixture rather than reusing a row created by an earlier test, so this
    // block passes in isolation (e.g. under `jest -t`).
    const ALERT_GEOFENCE_ID = 'alert-fixture-geofence';

    beforeAll(async () => {
      await insertGeofence({ id: ALERT_GEOFENCE_ID });
    });

    it('rejects an out-of-range latitude', async () => {
      await expect(
        prisma.$executeRaw`
          INSERT INTO "AlertEvent"
            ("id", "geofenceId", "eventType", "message", "latitude", "createdAt", "updatedAt")
          VALUES ('bad-alert-lat', ${ALERT_GEOFENCE_ID}, 'ENTER', 'test', ${91}, NOW(), NOW())
        `,
      ).rejects.toThrow(/AlertEvent_latitude_range_check/);
    });

    it('allows null coordinates (no ingestion exists yet)', async () => {
      await expect(
        prisma.$executeRaw`
          INSERT INTO "AlertEvent"
            ("id", "geofenceId", "eventType", "message", "createdAt", "updatedAt")
          VALUES ('null-coord-alert', ${ALERT_GEOFENCE_ID}, 'ENTER', 'test', NOW(), NOW())
        `,
      ).resolves.toBe(1);
    });
  });

  describe('the application path is bounded too', () => {
    it('rejects an out-of-range latitude written through Prisma Client', async () => {
      await expect(
        prisma.geofence.create({
          data: {
            name: 'Out of range',
            latitude: 91,
            longitude: 0,
            radiusMeters: 100,
            tenant: { connect: { id: tenantId } },
          },
        }),
      ).rejects.toThrow(/Geofence_latitude_range_check/);
    });
  });
});
