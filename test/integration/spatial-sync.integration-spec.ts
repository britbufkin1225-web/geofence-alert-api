import { PrismaService } from '../../src/prisma/prisma.service';
import { createPrismaService, truncateAll } from './support/database';

/**
 * Proves the storage contract of the canonical spatial column: that the scalar
 * latitude/longitude the API writes always produce the correct
 * geography(Point, 4326) value, in the correct axis order, and that the two
 * representations cannot be made to disagree.
 *
 * This is a STORAGE correctness suite only. No containment, distance or
 * ST_DWithin evaluation is exercised — that is GF-4 and later work.
 */
describe('GF-3 scalar/spatial synchronization (disposable PostgreSQL/PostGIS)', () => {
  let prisma: PrismaService;
  let tenantId: string;

  interface SpatialRow {
    x: number;
    y: number;
    srid: number;
    geometry_type: string;
  }

  const readPoint = async (id: string): Promise<SpatialRow> => {
    const rows = await prisma.$queryRaw<SpatialRow[]>`
      SELECT ST_X("centerPoint"::geometry) AS x,
             ST_Y("centerPoint"::geometry) AS y,
             ST_SRID("centerPoint"::geometry) AS srid,
             GeometryType("centerPoint"::geometry) AS geometry_type
      FROM "Geofence"
      WHERE "id" = ${id}
    `;
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  const createGeofence = (name: string, latitude: number, longitude: number) =>
    prisma.geofence.create({
      data: {
        name,
        latitude,
        longitude,
        radiusMeters: 100,
        tenant: { connect: { id: tenantId } },
      },
    });

  beforeAll(async () => {
    prisma = createPrismaService();
    await prisma.$connect();
    await truncateAll(prisma);
    const tenant = await prisma.tenant.create({
      data: { name: 'Spatial Fixture Tenant' },
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await truncateAll(prisma);
    await prisma.$disconnect();
  });

  describe('insert', () => {
    it('derives a Point with longitude as X and latitude as Y', async () => {
      // Austin, TX. The two coordinates differ in sign and magnitude, so a
      // swapped axis order cannot accidentally still pass.
      const created = await createGeofence('Austin', 30.2672, -97.7431);
      const point = await readPoint(created.id);

      expect(point.geometry_type).toBe('POINT');
      expect(point.x).toBeCloseTo(-97.7431, 9); // X = longitude
      expect(point.y).toBeCloseTo(30.2672, 9); // Y = latitude
      expect(point.srid).toBe(4326);
    });

    it('would be out of range if the axes were swapped', async () => {
      // Latitude 30.2672 is a legal longitude, but longitude -97.7431 is NOT a
      // legal latitude. Reading X back as a latitude would therefore be absurd —
      // this assertion documents that the ordering is meaningful, not arbitrary.
      const created = await createGeofence('Axis check', 30.2672, -97.7431);
      const point = await readPoint(created.id);

      expect(Math.abs(point.y)).toBeLessThanOrEqual(90);
      expect(Math.abs(point.x)).toBeGreaterThan(90);
    });

    it('holds at the coordinate extremes', async () => {
      const created = await createGeofence('Antimeridian south', -90, 180);
      const point = await readPoint(created.id);

      expect(point.x).toBeCloseTo(180, 9);
      expect(point.y).toBeCloseTo(-90, 9);
      expect(point.srid).toBe(4326);
    });
  });

  describe('update', () => {
    it('recomputes the point when the coordinates change', async () => {
      const created = await createGeofence('Moving zone', 30.2672, -97.7431);

      await prisma.geofence.update({
        where: { id: created.id },
        data: { latitude: -33.8688, longitude: 151.2093 }, // Sydney
      });

      const point = await readPoint(created.id);
      expect(point.x).toBeCloseTo(151.2093, 9);
      expect(point.y).toBeCloseTo(-33.8688, 9);
      expect(point.srid).toBe(4326);
    });

    it('keeps SRID 4326 after an update', async () => {
      const created = await createGeofence('SRID stability', 10, 10);
      await prisma.geofence.update({
        where: { id: created.id },
        data: { latitude: 11 },
      });
      expect((await readPoint(created.id)).srid).toBe(4326);
    });

    it('updates the point when only one coordinate changes', async () => {
      const created = await createGeofence('Single axis', 10, 20);
      await prisma.geofence.update({
        where: { id: created.id },
        data: { longitude: 25 },
      });

      const point = await readPoint(created.id);
      expect(point.x).toBeCloseTo(25, 9);
      expect(point.y).toBeCloseTo(10, 9);
    });
  });

  describe('the two representations cannot diverge', () => {
    it('refuses a direct UPDATE of the geography column', async () => {
      const created = await createGeofence('Tamper target', 10, 20);

      await expect(
        prisma.$executeRaw`
          UPDATE "Geofence"
          SET "centerPoint" = ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography
          WHERE "id" = ${created.id}
        `,
      ).rejects.toThrow(/can only be updated to DEFAULT|generated column/i);

      // Unchanged.
      const point = await readPoint(created.id);
      expect(point.x).toBeCloseTo(20, 9);
      expect(point.y).toBeCloseTo(10, 9);
    });

    it('refuses a direct INSERT that supplies the geography column', async () => {
      await expect(
        prisma.$executeRaw`
          INSERT INTO "Geofence"
            ("id", "tenantId", "name", "latitude", "longitude", "radiusMeters", "centerPoint", "createdAt", "updatedAt")
          VALUES ('forced-point', ${tenantId}, 'Forced', 1, 2, 100,
                  ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography, NOW(), NOW())
        `,
      ).rejects.toThrow(/cannot insert a non-DEFAULT value|generated column/i);
    });

    it('never has a row whose point disagrees with its scalars', async () => {
      const [{ mismatches }] = await prisma.$queryRaw<
        Array<{ mismatches: bigint }>
      >`
        SELECT COUNT(*) AS mismatches
        FROM "Geofence"
        WHERE ST_X("centerPoint"::geometry) IS DISTINCT FROM "longitude"
           OR ST_Y("centerPoint"::geometry) IS DISTINCT FROM "latitude"
      `;
      expect(Number(mismatches)).toBe(0);
    });
  });

  describe('application contract is unchanged', () => {
    it('does not expose the geography column through Prisma Client', async () => {
      const created = await createGeofence('Contract check', 5, 6);
      const found = await prisma.geofence.findUniqueOrThrow({
        where: { id: created.id },
      });

      // The scalar fields remain the read/write representation for the API.
      expect(found.latitude).toBe(5);
      expect(found.longitude).toBe(6);
      expect(Object.keys(found)).not.toContain('centerPoint');
    });
  });
});
