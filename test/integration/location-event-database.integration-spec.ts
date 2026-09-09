import { PrismaService } from '../../src/prisma/prisma.service';
import { isPrismaUniqueConstraint } from '../../src/common/prisma-unique-constraint';
import { createPrismaService, truncateAll } from './support/database';

/**
 * Structural and constraint proof for the GF-4 tracked-device and location-event
 * tables, run against the disposable database after `prisma migrate deploy` has
 * applied the committed migrations.
 *
 * Every insert here goes through raw, parameterized SQL that bypasses the NestJS
 * validation pipe entirely, so a passing test means data written by any future
 * client — a worker, a psql session, a bad migration — is still bounded. Only
 * static identifiers appear inline.
 */
describe('GF-4 location-event database layer (disposable PostgreSQL/PostGIS)', () => {
  let prisma: PrismaService;
  let tenantId: string;
  let otherTenantId: string;
  let deviceId: string;
  let otherDeviceId: string;

  const VALID = {
    observedAt: new Date('2026-09-09T06:00:00.000Z'),
    latitude: 30.2672,
    longitude: -97.7431,
    accuracyMeters: 8.5,
  };

  /** Raw, parameterized insert that deliberately skips application validation. */
  const insertEvent = (overrides: {
    id: string;
    tenantId?: string;
    trackedDeviceId?: string;
    eventKey?: string;
    observedAt?: Date;
    latitude?: number;
    longitude?: number;
    accuracyMeters?: number;
  }) =>
    prisma.$executeRaw`
      INSERT INTO "LocationEvent"
        ("id", "tenantId", "trackedDeviceId", "eventKey", "observedAt",
         "receivedAt", "latitude", "longitude", "accuracyMeters")
      VALUES (
        ${overrides.id},
        ${overrides.tenantId ?? tenantId},
        ${overrides.trackedDeviceId ?? deviceId},
        ${overrides.eventKey ?? overrides.id},
        ${overrides.observedAt ?? VALID.observedAt},
        NOW(),
        ${overrides.latitude ?? VALID.latitude},
        ${overrides.longitude ?? VALID.longitude},
        ${overrides.accuracyMeters ?? VALID.accuracyMeters}
      )
    `;

  beforeAll(async () => {
    prisma = createPrismaService();
    await prisma.$connect();
    await truncateAll(prisma);

    const tenant = await prisma.tenant.create({
      data: { name: 'GF4 Fixture Tenant' },
    });
    const otherTenant = await prisma.tenant.create({
      data: { name: 'GF4 Other Tenant' },
    });
    tenantId = tenant.id;
    otherTenantId = otherTenant.id;

    const device = await prisma.trackedDevice.create({
      data: { deviceKey: 'fixture-a', name: 'Fixture A', tenantId },
    });
    const otherDevice = await prisma.trackedDevice.create({
      data: {
        deviceKey: 'fixture-b',
        name: 'Fixture B',
        tenantId: otherTenantId,
      },
    });
    deviceId = device.id;
    otherDeviceId = otherDevice.id;
  });

  afterAll(async () => {
    await truncateAll(prisma);
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await prisma.locationEvent.deleteMany({});
  });

  describe('migration deployment', () => {
    // The complete migration ledger is asserted once, in
    // database-structure.integration-spec.ts. This narrows to the two GF-4
    // migrations so the phase's own additions are proven applied here without
    // creating a second full list to keep in sync.
    it('records the GF-4 migrations as applied and not rolled back', async () => {
      const rows = await prisma.$queryRaw<
        Array<{
          migration_name: string;
          finished: boolean;
          rolled_back: boolean;
        }>
      >`
        SELECT migration_name,
               finished_at IS NOT NULL AS finished,
               rolled_back_at IS NOT NULL AS rolled_back
        FROM _prisma_migrations
        WHERE migration_name IN (
          '20260909063002_tracked_devices_and_location_events',
          '20260909063100_location_event_spatial_constraints'
        )
        ORDER BY migration_name
      `;

      expect(rows.map((row) => row.migration_name)).toEqual([
        '20260909063002_tracked_devices_and_location_events',
        '20260909063100_location_event_spatial_constraints',
      ]);
      expect(rows.every((row) => row.finished)).toBe(true);
      expect(rows.some((row) => row.rolled_back)).toBe(false);
    });
  });

  describe('canonical observation geography column', () => {
    it('exists as geography(Point, 4326) with 2 dimensions', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ type: string; srid: number; coord_dimension: number }>
      >`
        SELECT type, srid, coord_dimension
        FROM geography_columns
        WHERE f_table_name = 'LocationEvent'
          AND f_geography_column = 'observedPoint'
      `;

      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('Point');
      expect(rows[0].srid).toBe(4326);
      expect(rows[0].coord_dimension).toBe(2);
    });

    it('is a STORED GENERATED NOT NULL column', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ attgenerated: string; attnotnull: boolean; coltype: string }>
      >`
        SELECT attgenerated::text AS attgenerated,
               attnotnull,
               format_type(atttypid, atttypmod) AS coltype
        FROM pg_attribute
        WHERE attrelid = '"LocationEvent"'::regclass
          AND attname = 'observedPoint'
      `;

      expect(rows).toHaveLength(1);
      // 's' = stored generated: divergence is impossible, not merely unlikely.
      expect(rows[0].attgenerated).toBe('s');
      expect(rows[0].attnotnull).toBe(true);
      expect(rows[0].coltype).toBe('geography(Point,4326)');
    });

    it('derives the point from longitude (X) and latitude (Y)', async () => {
      const [{ definition }] = await prisma.$queryRaw<
        Array<{ definition: string }>
      >`
        SELECT pg_get_expr(adbin, adrelid) AS definition
        FROM pg_attrdef
        WHERE adrelid = '"LocationEvent"'::regclass
          AND adnum = (
            SELECT attnum FROM pg_attribute
            WHERE attrelid = '"LocationEvent"'::regclass
              AND attname = 'observedPoint'
          )
      `;

      expect(definition.replace(/\s+/g, ' ')).toContain(
        'st_makepoint(longitude, latitude)',
      );
      expect(definition).toContain('4326');
    });

    it('computes the point for a row inserted outside the application', async () => {
      await insertEvent({ id: 'raw-point' });

      const [point] = await prisma.$queryRaw<
        Array<{ x: number; y: number; srid: number }>
      >`
        SELECT ST_X("observedPoint"::geometry) AS x,
               ST_Y("observedPoint"::geometry) AS y,
               ST_SRID("observedPoint"::geometry) AS srid
        FROM "LocationEvent" WHERE "id" = 'raw-point'
      `;

      expect(point.x).toBeCloseTo(VALID.longitude, 9);
      expect(point.y).toBeCloseTo(VALID.latitude, 9);
      expect(point.srid).toBe(4326);
    });
  });

  describe('timestamp storage', () => {
    it('stores observedAt and receivedAt as timestamptz(3)', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ column_name: string; coltype: string }>
      >`
        SELECT attname AS column_name,
               format_type(atttypid, atttypmod) AS coltype
        FROM pg_attribute
        WHERE attrelid = '"LocationEvent"'::regclass
          AND attname IN ('observedAt', 'receivedAt')
        ORDER BY attname
      `;

      expect(rows).toEqual([
        { column_name: 'observedAt', coltype: 'timestamp(3) with time zone' },
        { column_name: 'receivedAt', coltype: 'timestamp(3) with time zone' },
      ]);
    });

    it('preserves the database instant under a hostile session time zone', async () => {
      await insertEvent({ id: 'tz-roundtrip' });

      // Read the same row back under a deliberately hostile session zone. A
      // `timestamp without time zone` column would shift here; timestamptz does
      // not, which is why the column type was chosen.
      const epoch = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL TIME ZONE 'Pacific/Kiritimati'`;
        const [zone] = await tx.$queryRaw<Array<{ zone: string }>>`
          SELECT current_setting('TimeZone') AS zone
        `;
        expect(zone.zone).toBe('Pacific/Kiritimati');
        // Read epoch rather than using adapter-pg's broken non-UTC timestamptz
        // parser. Application connections are separately pinned to UTC below.
        const [row] = await tx.$queryRaw<Array<{ epoch: number }>>`
          SELECT (EXTRACT(EPOCH FROM "observedAt") * 1000)::float8 AS epoch
          FROM "LocationEvent" WHERE id = 'tz-roundtrip'
        `;
        return row.epoch;
      });

      expect(epoch).toBe(VALID.observedAt.getTime());
    });

    it('pins Prisma connections to UTC even with a hostile URL timezone', async () => {
      await insertEvent({ id: 'utc-adapter' });
      const originalUrl = process.env.DATABASE_URL!;
      const url = new URL(originalUrl);
      url.searchParams.set('options', '-c timezone=Pacific/Kiritimati');
      let isolated: PrismaService;
      try {
        process.env.DATABASE_URL = url.toString();
        isolated = new PrismaService();
      } finally {
        process.env.DATABASE_URL = originalUrl;
      }
      try {
        const [zone] = await isolated.$queryRaw<Array<{ zone: string }>>`
          SELECT current_setting('TimeZone') AS zone
        `;
        expect(zone.zone).toBe('UTC');
        const stored = await isolated.locationEvent.findUniqueOrThrow({
          where: { id: 'utc-adapter' },
        });
        expect(stored.observedAt.toISOString()).toBe(
          VALID.observedAt.toISOString(),
        );
      } finally {
        await isolated.$disconnect();
      }
    });
  });

  describe('coordinate constraints', () => {
    it.each([
      ['latitude below -90', { latitude: -90.000001 }],
      ['latitude above 90', { latitude: 90.000001 }],
    ])('rejects %s', async (_label, override) => {
      await expect(insertEvent({ id: 'bad-lat', ...override })).rejects.toThrow(
        /LocationEvent_latitude_range_check/,
      );
    });

    it.each([
      ['longitude below -180', { longitude: -180.000001 }],
      ['longitude above 180', { longitude: 180.000001 }],
    ])('rejects %s', async (_label, override) => {
      await expect(insertEvent({ id: 'bad-lng', ...override })).rejects.toThrow(
        /LocationEvent_longitude_range_check/,
      );
    });

    it.each([
      ['latitude -90', { latitude: -90 }],
      ['latitude 90', { latitude: 90 }],
      ['longitude -180', { longitude: -180 }],
      ['longitude 180', { longitude: 180 }],
      ['zero coordinates', { latitude: 0, longitude: 0 }],
    ])('accepts the %s boundary', async (_label, override) => {
      await expect(
        insertEvent({ id: `ok-${Math.random()}`, ...override }),
      ).resolves.toBe(1);
    });

    it('explicitly rejects NaN coordinates', async () => {
      // PostgreSQL orders NaN above finite values, so the upper range bound
      // also rejects it. This checks the explicit finite constraint.
      //
      // The literals are written into the static SQL rather than bound as
      // parameters because the driver marshals a JavaScript NaN to SQL NULL,
      // which would exercise the NOT NULL constraint instead of this one. No
      // value below comes from test input.
      await expect(
        prisma.$executeRaw`
          INSERT INTO "LocationEvent"
            ("id", "tenantId", "trackedDeviceId", "eventKey", "observedAt",
             "receivedAt", "latitude", "longitude", "accuracyMeters")
          VALUES ('nan-lat', ${tenantId}, ${deviceId}, 'nan-lat',
                  ${VALID.observedAt}, NOW(),
                  'NaN'::double precision, ${VALID.longitude},
                  ${VALID.accuracyMeters})
        `,
      ).rejects.toThrow(/LocationEvent_coordinates_finite_check/);

      await expect(
        prisma.$executeRaw`
          INSERT INTO "LocationEvent"
            ("id", "tenantId", "trackedDeviceId", "eventKey", "observedAt",
             "receivedAt", "latitude", "longitude", "accuracyMeters")
          VALUES ('nan-lng', ${tenantId}, ${deviceId}, 'nan-lng',
                  ${VALID.observedAt}, NOW(),
                  ${VALID.latitude}, 'NaN'::double precision,
                  ${VALID.accuracyMeters})
        `,
      ).rejects.toThrow(/LocationEvent_coordinates_finite_check/);
    });
  });

  describe('accuracy constraints', () => {
    it('rejects a negative accuracy', async () => {
      await expect(
        insertEvent({ id: 'neg-acc', accuracyMeters: -0.000001 }),
      ).rejects.toThrow(/LocationEvent_accuracyMeters_range_check/);
    });

    it('rejects an accuracy beyond the documented ceiling', async () => {
      await expect(
        insertEvent({ id: 'huge-acc', accuracyMeters: 100000.000001 }),
      ).rejects.toThrow(/LocationEvent_accuracyMeters_range_check/);
    });

    it('rejects a NaN accuracy', async () => {
      // Literal cast, for the same reason as the NaN coordinate case above.
      await expect(
        prisma.$executeRaw`
          INSERT INTO "LocationEvent"
            ("id", "tenantId", "trackedDeviceId", "eventKey", "observedAt",
             "receivedAt", "latitude", "longitude", "accuracyMeters")
          VALUES ('nan-acc', ${tenantId}, ${deviceId}, 'nan-acc',
                  ${VALID.observedAt}, NOW(),
                  ${VALID.latitude}, ${VALID.longitude},
                  'NaN'::double precision)
        `,
      ).rejects.toThrow(/LocationEvent_accuracyMeters_range_check/);
    });

    it('rejects an infinite accuracy', async () => {
      await expect(
        prisma.$executeRaw`
          INSERT INTO "LocationEvent"
            ("id", "tenantId", "trackedDeviceId", "eventKey", "observedAt",
             "receivedAt", "latitude", "longitude", "accuracyMeters")
          VALUES ('inf-acc', ${tenantId}, ${deviceId}, 'inf-acc',
                  ${VALID.observedAt}, NOW(),
                  ${VALID.latitude}, ${VALID.longitude},
                  'Infinity'::double precision)
        `,
      ).rejects.toThrow(/LocationEvent_accuracyMeters_range_check/);
    });

    it.each([
      ['zero', 0],
      ['the ceiling', 100000],
    ])('accepts %s', async (_label, accuracyMeters) => {
      await expect(
        insertEvent({ id: `acc-${accuracyMeters}`, accuracyMeters }),
      ).resolves.toBe(1);
    });
  });

  describe('identifier constraints', () => {
    it('rejects an empty eventKey', async () => {
      await expect(
        insertEvent({ id: 'blank-key', eventKey: '' }),
      ).rejects.toThrow(/LocationEvent_eventKey_not_blank_check/);
    });

    it('rejects a whitespace-only eventKey, including non-ASCII whitespace', async () => {
      await expect(
        insertEvent({ id: 'tab-key', eventKey: '\t\n ' }),
      ).rejects.toThrow(/LocationEvent_eventKey_not_blank_check/);
      await expect(
        insertEvent({ id: 'nbsp-key', eventKey: ' 　' }),
      ).rejects.toThrow(/LocationEvent_eventKey_not_blank_check/);
    });

    it('rejects an oversized eventKey', async () => {
      await expect(
        insertEvent({ id: 'long-key', eventKey: 'e'.repeat(201) }),
      ).rejects.toThrow(/value too long/i);
    });

    it('rejects blank tracked-device identifiers and names', async () => {
      await expect(
        prisma.$executeRaw`
          INSERT INTO "TrackedDevice"
            ("id", "tenantId", "deviceKey", "name", "isActive", "createdAt", "updatedAt")
          VALUES ('blank-device-key', ${tenantId}, '  ', 'Name', true, NOW(), NOW())
        `,
      ).rejects.toThrow(/TrackedDevice_deviceKey_not_blank_check/);

      await expect(
        prisma.$executeRaw`
          INSERT INTO "TrackedDevice"
            ("id", "tenantId", "deviceKey", "name", "isActive", "createdAt", "updatedAt")
          VALUES ('blank-device-name', ${tenantId}, 'key', '\t', true, NOW(), NOW())
        `,
      ).rejects.toThrow(/TrackedDevice_name_not_blank_check/);
    });
  });

  describe('ownership integrity', () => {
    it('rejects tenant disagreement through Prisma unchecked create', async () => {
      await expect(
        prisma.locationEvent.create({
          data: {
            tenantId: otherTenantId,
            trackedDeviceId: deviceId,
            eventKey: 'unchecked-mismatch',
            ...VALID,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('rejects an event whose tenant disagrees with its device tenant', async () => {
      // The composite foreign key makes this structurally impossible rather
      // than merely prevented by the service layer.
      await expect(
        insertEvent({ id: 'mismatch', tenantId: otherTenantId }),
      ).rejects.toThrow(/LocationEvent_trackedDeviceId_tenantId_fkey/);

      await expect(
        insertEvent({ id: 'mismatch-2', trackedDeviceId: otherDeviceId }),
      ).rejects.toThrow(/LocationEvent_trackedDeviceId_tenantId_fkey/);
    });

    it('rejects an event for a device that does not exist', async () => {
      await expect(
        insertEvent({ id: 'orphan', trackedDeviceId: 'no-such-device' }),
      ).rejects.toThrow(/LocationEvent_trackedDeviceId_tenantId_fkey/);
    });

    it('rejects a tracked device for a tenant that does not exist', async () => {
      await expect(
        prisma.$executeRaw`
          INSERT INTO "TrackedDevice"
            ("id", "tenantId", "deviceKey", "name", "isActive", "createdAt", "updatedAt")
          VALUES ('orphan-device', 'no-such-tenant', 'k', 'n', true, NOW(), NOW())
        `,
      ).rejects.toThrow(/TrackedDevice_tenantId_fkey/);
    });

    it('cascades a tenant deletion through devices to events', async () => {
      const doomed = await prisma.tenant.create({ data: { name: 'Doomed' } });
      const device = await prisma.trackedDevice.create({
        data: { tenantId: doomed.id, deviceKey: 'doomed-1', name: 'Doomed 1' },
      });
      await prisma.locationEvent.create({
        data: {
          tenantId: doomed.id,
          trackedDeviceId: device.id,
          eventKey: 'doomed-evt',
          observedAt: VALID.observedAt,
          latitude: VALID.latitude,
          longitude: VALID.longitude,
          accuracyMeters: VALID.accuracyMeters,
        },
      });

      await prisma.tenant.delete({ where: { id: doomed.id } });

      expect(
        await prisma.trackedDevice.count({ where: { tenantId: doomed.id } }),
      ).toBe(0);
      expect(
        await prisma.locationEvent.count({ where: { tenantId: doomed.id } }),
      ).toBe(0);
    });
  });

  describe('idempotency constraint', () => {
    it('distinguishes real adapter idempotency and primary-key violations', async () => {
      const data = {
        tenantId,
        trackedDeviceId: deviceId,
        eventKey: 'adapter',
        ...VALID,
      };
      const created = await prisma.locationEvent.create({ data });
      const collision = async (input: typeof data & { id?: string }) => {
        try {
          await prisma.locationEvent.create({ data: input });
          throw new Error('Expected a database collision');
        } catch (error) {
          expect(error).toMatchObject({ code: 'P2002' });
          return isPrismaUniqueConstraint(
            error,
            'LocationEvent',
            'LocationEvent_tenantId_trackedDeviceId_eventKey_key',
          );
        }
      };
      expect(await collision(data)).toBe(true);
      expect(
        await collision({ ...data, id: created.id, eventKey: 'different' }),
      ).toBe(false);
    });

    it('rejects a duplicate (tenant, device, eventKey) triple', async () => {
      await insertEvent({ id: 'dup-1', eventKey: 'same-key' });

      await expect(
        insertEvent({ id: 'dup-2', eventKey: 'same-key' }),
      ).rejects.toThrow(/LocationEvent_tenantId_trackedDeviceId_eventKey_key/);
    });

    it('allows the same eventKey on a different device in the same tenant', async () => {
      const second = await prisma.trackedDevice.create({
        data: { tenantId, deviceKey: 'fixture-a2', name: 'Fixture A2' },
      });

      await insertEvent({ id: 'scoped-1', eventKey: 'shared' });
      await expect(
        insertEvent({
          id: 'scoped-2',
          eventKey: 'shared',
          trackedDeviceId: second.id,
        }),
      ).resolves.toBe(1);
    });

    it('allows the same eventKey in a different tenant', async () => {
      await insertEvent({ id: 'tenant-1', eventKey: 'cross-tenant' });
      await expect(
        insertEvent({
          id: 'tenant-2',
          eventKey: 'cross-tenant',
          tenantId: otherTenantId,
          trackedDeviceId: otherDeviceId,
        }),
      ).resolves.toBe(1);
    });
  });

  describe('declared constraints and indexes', () => {
    it('has exactly the intended CHECK constraints', async () => {
      const rows = await prisma.$queryRaw<Array<{ constraint_name: string }>>`
        SELECT conname AS constraint_name
        FROM pg_constraint
        WHERE contype = 'c'
          AND conrelid IN (
            '"TrackedDevice"'::regclass, '"LocationEvent"'::regclass
          )
        ORDER BY conname
      `;

      expect(rows.map((row) => row.constraint_name)).toEqual([
        'LocationEvent_accuracyMeters_range_check',
        'LocationEvent_coordinates_finite_check',
        'LocationEvent_eventKey_not_blank_check',
        'LocationEvent_latitude_range_check',
        'LocationEvent_longitude_range_check',
        'TrackedDevice_deviceKey_not_blank_check',
        'TrackedDevice_name_not_blank_check',
      ]);
    });

    it('has the uniqueness rules the idempotency contract depends on', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ index_name: string; definition: string }>
      >`
        SELECT i.relname AS index_name,
               pg_get_indexdef(x.indexrelid) AS definition
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class t ON t.oid = x.indrelid
        WHERE x.indisunique
          AND t.relname IN ('TrackedDevice', 'LocationEvent')
        ORDER BY i.relname
      `;

      expect(rows.map((row) => row.index_name)).toEqual([
        // Added by GF-6 so GeofenceDeviceState can carry a composite foreign key
        // onto (id, tenantId) and never cite a source event of another tenant.
        'LocationEvent_id_tenantId_key',
        'LocationEvent_pkey',
        'LocationEvent_tenantId_trackedDeviceId_eventKey_key',
        'TrackedDevice_id_tenantId_key',
        'TrackedDevice_pkey',
        'TrackedDevice_tenantId_deviceKey_key',
      ]);

      const byName = new Map(
        rows.map((row) => [row.index_name, row.definition]),
      );
      // The idempotency key is tenant-qualified in its own right.
      expect(
        byName.get('LocationEvent_tenantId_trackedDeviceId_eventKey_key'),
      ).toContain('"tenantId", "trackedDeviceId", "eventKey"');
      expect(byName.get('LocationEvent_id_tenantId_key')).toContain(
        '(id, "tenantId")',
      );
    });

    it('has the tenant lookup indexes', async () => {
      const rows = await prisma.$queryRaw<Array<{ index_name: string }>>`
        SELECT i.relname AS index_name
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        WHERE i.relname IN (
          'TrackedDevice_tenantId_idx',
          'LocationEvent_tenantId_trackedDeviceId_observedAt_idx'
        )
        ORDER BY i.relname
      `;

      expect(rows.map((row) => row.index_name)).toEqual([
        'LocationEvent_tenantId_trackedDeviceId_observedAt_idx',
        'TrackedDevice_tenantId_idx',
      ]);
    });

    it('has the composite foreign key that binds event tenant to device tenant', async () => {
      const [row] = await prisma.$queryRaw<Array<{ definition: string }>>`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conname = 'LocationEvent_trackedDeviceId_tenantId_fkey'
      `;

      expect(row.definition).toContain(
        'FOREIGN KEY ("trackedDeviceId", "tenantId") REFERENCES "TrackedDevice"(id, "tenantId")',
      );
      expect(row.definition).toContain('ON DELETE CASCADE');
    });

    it('has no spatial index on LocationEvent, as decided in the migration', async () => {
      // Asserted so the omission stays a recorded decision (no committed query
      // path needs it) rather than an oversight. Adding one is a one-line change
      // whenever a real query justifies it.
      const rows = await prisma.$queryRaw<Array<{ index_name: string }>>`
        SELECT i.relname AS index_name
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_am am ON am.oid = i.relam
        WHERE t.relname = 'LocationEvent' AND am.amname = 'gist'
      `;

      expect(rows).toEqual([]);
    });

    it('keeps the GF-3 geofence spatial index intact', async () => {
      const rows = await prisma.$queryRaw<Array<{ index_name: string }>>`
        SELECT i.relname AS index_name
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_am am ON am.oid = i.relam
        WHERE t.relname = 'Geofence' AND am.amname = 'gist'
      `;

      expect(rows.map((row) => row.index_name)).toEqual([
        'Geofence_centerPoint_gist_idx',
      ]);
    });
  });

  describe('bounded string columns match the API contract', () => {
    it('applies the documented lengths', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ table_name: string; column_name: string; max_length: number }>
      >`
        SELECT table_name, column_name, character_maximum_length AS max_length
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('TrackedDevice', 'LocationEvent')
          AND character_maximum_length IS NOT NULL
        ORDER BY table_name, column_name
      `;

      expect(rows).toEqual([
        {
          table_name: 'LocationEvent',
          column_name: 'eventKey',
          max_length: 200,
        },
        {
          table_name: 'TrackedDevice',
          column_name: 'deviceKey',
          max_length: 128,
        },
        { table_name: 'TrackedDevice', column_name: 'name', max_length: 120 },
      ]);
    });
  });
});
