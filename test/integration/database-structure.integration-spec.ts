import { PrismaService } from '../../src/prisma/prisma.service';
import { createPrismaService } from './support/database';

/**
 * Structural proof for the GF-3 PostgreSQL/PostGIS foundation, run against the
 * disposable database after `prisma migrate deploy` has applied the committed
 * migrations to it. Everything asserted here is a property of the deployed
 * schema, not of application code, so a mocked Prisma client could not prove any
 * of it.
 *
 * All runtime values are passed as query parameters; only static identifiers
 * appear inline.
 */
describe('GF-3 database structure (disposable PostgreSQL/PostGIS)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = createPrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('migration deployment', () => {
    it('records every committed migration as applied and not rolled back', async () => {
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
        ORDER BY migration_name
      `;

      expect(rows.map((row) => row.migration_name)).toEqual([
        '20260908102300_enable_postgis',
        '20260908102319_init_postgresql_baseline',
        '20260908102400_geofence_spatial_constraints',
      ]);
      expect(rows.every((row) => row.finished)).toBe(true);
      expect(rows.some((row) => row.rolled_back)).toBe(false);
    });

    it('runs on PostgreSQL, not SQLite', async () => {
      const [{ version }] = await prisma.$queryRaw<
        Array<{ version: string }>
      >`SELECT version() AS version`;
      expect(version).toContain('PostgreSQL');
    });
  });

  describe('PostGIS extension', () => {
    it('is installed', async () => {
      const rows = await prisma.$queryRaw<Array<{ extversion: string }>>`
        SELECT extversion FROM pg_extension WHERE extname = 'postgis'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].extversion).toMatch(/^\d+\.\d+/);
    });

    it('exposes the spatial functions the schema depends on', async () => {
      const [{ srid }] = await prisma.$queryRaw<Array<{ srid: number }>>`
        SELECT ST_SRID(ST_SetSRID(ST_MakePoint(0, 0), 4326)) AS srid
      `;
      expect(srid).toBe(4326);
    });
  });

  describe('canonical geofence geography column', () => {
    it('exists as geography(Point, 4326) with 2 dimensions', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ type: string; srid: number; coord_dimension: number }>
      >`
        SELECT type, srid, coord_dimension
        FROM geography_columns
        WHERE f_table_name = 'Geofence' AND f_geography_column = 'centerPoint'
      `;

      expect(rows).toHaveLength(1);
      // Subtype is Point, and the spatial reference system is WGS 84.
      expect(rows[0].type).toBe('Point');
      expect(rows[0].srid).toBe(4326);
      expect(rows[0].coord_dimension).toBe(2);
    });

    it('is a STORED GENERATED column that PostgreSQL maintains itself', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ attgenerated: string; attnotnull: boolean; coltype: string }>
      >`
        SELECT attgenerated::text AS attgenerated,
               attnotnull,
               format_type(atttypid, atttypmod) AS coltype
        FROM pg_attribute
        WHERE attrelid = '"Geofence"'::regclass AND attname = 'centerPoint'
      `;

      expect(rows).toHaveLength(1);
      // 's' = stored generated. This is what makes scalar/spatial divergence
      // impossible rather than merely unlikely.
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
        WHERE adrelid = '"Geofence"'::regclass
          AND adnum = (
            SELECT attnum FROM pg_attribute
            WHERE attrelid = '"Geofence"'::regclass AND attname = 'centerPoint'
          )
      `;

      // st_makepoint(X, Y): longitude must be the first argument.
      expect(definition.replace(/\s+/g, ' ')).toContain(
        'st_makepoint(longitude, latitude)',
      );
      expect(definition).toContain('4326');
    });
  });

  describe('spatial index', () => {
    it('has a GiST index on the geography column', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ index_name: string; method: string; definition: string }>
      >`
        SELECT i.relname AS index_name,
               am.amname AS method,
               pg_get_indexdef(x.indexrelid) AS definition
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_am am ON am.oid = i.relam
        WHERE t.relname = 'Geofence' AND i.relname = 'Geofence_centerPoint_gist_idx'
      `;

      expect(rows).toHaveLength(1);
      expect(rows[0].method).toBe('gist');
      // Targets the intended column, not some other one.
      expect(rows[0].definition).toContain('"centerPoint"');
    });
  });

  describe('GF-2 ownership structure survives the PostgreSQL migration', () => {
    it('keeps every foreign key', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ constraint_name: string; definition: string }>
      >`
        SELECT conname AS constraint_name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid IN (
            '"User"'::regclass, '"Tenant"'::regclass, '"Membership"'::regclass,
            '"Geofence"'::regclass, '"AlertEvent"'::regclass
          )
        ORDER BY conname
      `;

      const byName = new Map(
        rows.map((row) => [row.constraint_name, row.definition]),
      );

      expect([...byName.keys()]).toEqual([
        'AlertEvent_geofenceId_fkey',
        'Geofence_tenantId_fkey',
        'Membership_tenantId_fkey',
        'Membership_userId_fkey',
      ]);
      expect(byName.get('Geofence_tenantId_fkey')).toContain(
        'FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id)',
      );
      // Ownership cascades, so a deleted tenant cannot leave orphaned rows.
      expect(byName.get('Geofence_tenantId_fkey')).toContain(
        'ON DELETE CASCADE',
      );
      expect(byName.get('Membership_userId_fkey')).toContain(
        'ON DELETE CASCADE',
      );
      expect(byName.get('Membership_tenantId_fkey')).toContain(
        'ON DELETE CASCADE',
      );
    });

    it('keeps tenant ownership required on Geofence', async () => {
      const rows = await prisma.$queryRaw<Array<{ attnotnull: boolean }>>`
        SELECT attnotnull
        FROM pg_attribute
        WHERE attrelid = '"Geofence"'::regclass AND attname = 'tenantId'
      `;
      expect(rows[0].attnotnull).toBe(true);
    });

    it('keeps the identity uniqueness rules', async () => {
      const rows = await prisma.$queryRaw<Array<{ index_name: string }>>`
        SELECT i.relname AS index_name
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        WHERE x.indisunique
          AND i.relname IN ('User_email_key', 'Membership_userId_tenantId_key')
        ORDER BY i.relname
      `;
      expect(rows.map((row) => row.index_name)).toEqual([
        'Membership_userId_tenantId_key',
        'User_email_key',
      ]);
    });

    it('keeps the tenant lookup indexes', async () => {
      const rows = await prisma.$queryRaw<Array<{ index_name: string }>>`
        SELECT i.relname AS index_name
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        WHERE i.relname IN ('Geofence_tenantId_idx', 'Membership_tenantId_idx')
        ORDER BY i.relname
      `;
      expect(rows.map((row) => row.index_name)).toEqual([
        'Geofence_tenantId_idx',
        'Membership_tenantId_idx',
      ]);
    });
  });

  describe('declared CHECK constraints', () => {
    it('are all present on the expected tables', async () => {
      const rows = await prisma.$queryRaw<Array<{ constraint_name: string }>>`
        SELECT conname AS constraint_name
        FROM pg_constraint
        WHERE contype = 'c'
          AND conrelid IN (
            '"User"'::regclass, '"Tenant"'::regclass, '"Membership"'::regclass,
            '"Geofence"'::regclass, '"AlertEvent"'::regclass
          )
        ORDER BY conname
      `;

      expect(rows.map((row) => row.constraint_name)).toEqual([
        'AlertEvent_latitude_range_check',
        'AlertEvent_longitude_range_check',
        'Geofence_latitude_range_check',
        'Geofence_longitude_range_check',
        'Geofence_name_not_blank_check',
        'Geofence_radiusMeters_max_check',
        'Geofence_radiusMeters_positive_check',
        'Tenant_name_not_blank_check',
        'User_email_not_blank_check',
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
          AND table_name IN ('User', 'Tenant', 'Membership', 'Geofence', 'AlertEvent')
          AND character_maximum_length IS NOT NULL
        ORDER BY table_name, column_name
      `;

      expect(rows).toEqual([
        {
          table_name: 'Geofence',
          column_name: 'description',
          max_length: 1000,
        },
        { table_name: 'Geofence', column_name: 'name', max_length: 120 },
        { table_name: 'Tenant', column_name: 'name', max_length: 120 },
        { table_name: 'User', column_name: 'email', max_length: 254 },
      ]);
    });
  });
});
