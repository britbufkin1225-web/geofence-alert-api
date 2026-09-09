import type { Server } from 'http';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { setupApp } from '../../src/app.setup';
import { GEOFENCE_RADIUS_MAX_METERS } from '../../src/geofences/dto/geofence.constants';
import { containmentStatement } from '../../src/location-events/geofence-containment.query';
import { PrismaService } from '../../src/prisma/prisma.service';
import { requireDisposableDatabaseUrl, truncateAll } from './support/database';

/**
 * REAL PostgreSQL/PostGIS proof for GF-5 point-in-circle evaluation, driven
 * through the HTTP API end-to-end against the disposable database that
 * `npm run test:db` provisions and migrates.
 *
 * Everything that actually decides containment lives in the database, so this is
 * the suite that can prove it: geography semantics in meters rather than
 * degrees, boundary inclusiveness, coordinate order, the active and tenant
 * filters, deterministic ordering, and the read-only guarantee. None of it is
 * mocked anywhere in this file.
 *
 * Exact-boundary fixtures never hand-round a decimal coordinate onto a circle.
 * They place the observation first and then set the geofence radius, in SQL, to
 * the exact double PostGIS measures between the two — so "on the boundary" is
 * an identity rather than an approximation.
 */

interface AuthResponse {
  accessToken: string;
  tenant: { id: string; name: string };
}

interface MatchBody {
  geofenceId: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  distanceMeters: number;
}

interface EvaluationBody {
  locationEventId: string;
  trackedDeviceId: string;
  observedAt: string;
  latitude: number;
  longitude: number;
  matches: MatchBody[];
  matchCount: number;
}

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
}

const OBSERVED_AT = new Date('2026-09-09T06:00:00.000Z');

// Austin, TX. Latitude and longitude differ in sign and magnitude, so a swapped
// axis order cannot accidentally still pass.
const AUSTIN = { latitude: 30.2672, longitude: -97.7431 };

// Deterministic ids that differ only in their last character, so the
// equal-distance tie-breaker is unambiguous under any database collation.
const TIE_GEOFENCE_A = 'cgftie0000000000000000001';
const TIE_GEOFENCE_B = 'cgftie0000000000000000002';

/**
 * Rows seeded before asking PostgreSQL to plan the containment statement. Small
 * enough to stay a fast fixture, large enough that a sequential scan is no
 * longer trivially the cheapest option.
 */
const INDEX_PLAN_FIXTURE_ROWS = 200;

describe('GF-5 geofence evaluation (real PostgreSQL/PostGIS integration)', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;

  let tokenA: string;
  let tokenB: string;
  let tenantAId: string;
  let tenantBId: string;
  let deviceAId: string;
  let deviceBId: string;

  let eventSeq = 0;

  const evaluate = (token: string, locationEventId: string) =>
    request(server)
      .get(`/api/v1/location-events/${locationEventId}/geofence-evaluation`)
      .set('Authorization', `Bearer ${token}`);

  const register = async (email: string, tenantName: string) => {
    const res = await request(server)
      .post('/api/v1/auth/register')
      .send({ email, password: 'password-Aa1', tenantName })
      .expect(201);
    return res.body as AuthResponse;
  };

  const createEvent = (
    tenantId: string,
    trackedDeviceId: string,
    coordinates: { latitude: number; longitude: number },
  ) =>
    prisma.locationEvent.create({
      data: {
        tenantId,
        trackedDeviceId,
        eventKey: `evt-${++eventSeq}`,
        observedAt: OBSERVED_AT,
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        accuracyMeters: 5,
      },
    });

  const createGeofence = (options: {
    tenantId: string;
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
    isActive?: boolean;
    id?: string;
  }) =>
    prisma.geofence.create({
      data: {
        id: options.id,
        tenantId: options.tenantId,
        name: options.name,
        latitude: options.latitude,
        longitude: options.longitude,
        radiusMeters: options.radiusMeters,
        isActive: options.isActive ?? true,
      },
    });

  /** The geodesic distance PostGIS itself measures, in meters. */
  const measuredDistance = async (
    geofenceId: string,
    locationEventId: string,
  ): Promise<number> => {
    const rows = await prisma.$queryRaw<Array<{ distance: number }>>`
      SELECT ST_Distance("g"."centerPoint", "e"."observedPoint") AS "distance"
      FROM "Geofence" AS "g", "LocationEvent" AS "e"
      WHERE "g"."id" = ${geofenceId} AND "e"."id" = ${locationEventId}
    `;
    expect(rows).toHaveLength(1);
    return rows[0].distance;
  };

  /**
   * Pins the geofence radius to the exact double PostGIS measures between the
   * circle center and the stored observation, offset by `deltaMeters`. With a
   * delta of 0 the observation sits precisely on the boundary — not near it.
   */
  const setRadiusFromDistance = (
    geofenceId: string,
    locationEventId: string,
    deltaMeters = 0,
  ) =>
    prisma.$executeRaw`
      UPDATE "Geofence"
      SET "radiusMeters" = (
        SELECT ST_Distance("Geofence"."centerPoint", "e"."observedPoint")
             + ${deltaMeters}::double precision
        FROM "LocationEvent" AS "e"
        WHERE "e"."id" = ${locationEventId}
      )
      WHERE "id" = ${geofenceId}
    `;

  /** A point at an exact geodesic distance and bearing from another point. */
  const project = async (
    origin: { latitude: number; longitude: number },
    distanceMeters: number,
    azimuthDegrees: number,
  ): Promise<{ latitude: number; longitude: number }> => {
    const rows = await prisma.$queryRaw<
      Array<{ latitude: number; longitude: number }>
    >`
      SELECT ST_Y("projected"::geometry) AS "latitude",
             ST_X("projected"::geometry) AS "longitude"
      FROM (
        SELECT ST_Project(
                 ST_SetSRID(
                   ST_MakePoint(
                     ${origin.longitude}::double precision,
                     ${origin.latitude}::double precision
                   ),
                   4326
                 )::geography,
                 ${distanceMeters}::double precision,
                 radians(${azimuthDegrees}::double precision)
               ) AS "projected"
      ) AS "point"
    `;
    return rows[0];
  };

  /** Row counts for every table in the schema, for the read-only proof. */
  const rowCounts = async (): Promise<Record<string, number>> => {
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;

    const counts: Record<string, number> = {};
    for (const { table_name: table } of tables) {
      // The identifier comes from the PostgreSQL catalog, never from test
      // input, and is re-checked here before it is used unparameterized.
      expect(table).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      const rows = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS "count" FROM "${table}"`,
      );
      counts[table] = rows[0].count;
    }
    return counts;
  };

  beforeAll(async () => {
    requireDisposableDatabaseUrl();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);

    await truncateAll(prisma);

    const a = await register('evaluation-a@example.com', 'Tenant A');
    const b = await register('evaluation-b@example.com', 'Tenant B');
    tokenA = a.accessToken;
    tokenB = b.accessToken;
    tenantAId = a.tenant.id;
    tenantBId = b.tenant.id;

    const registerDevice = async (token: string, deviceKey: string) => {
      const res = await request(server)
        .post('/api/v1/tracked-devices')
        .set('Authorization', `Bearer ${token}`)
        .send({ deviceKey, name: `Van ${deviceKey}` })
        .expect(201);
      return (res.body as { id: string }).id;
    };

    deviceAId = await registerDevice(tokenA, 'device-a1');
    deviceBId = await registerDevice(tokenB, 'device-b1');
  });

  afterAll(async () => {
    if (prisma) {
      await truncateAll(prisma);
    }
    if (app) {
      await app.close();
    }
  });

  afterEach(async () => {
    await prisma.locationEvent.deleteMany({});
    await prisma.geofence.deleteMany({});
  });

  describe('spatial correctness', () => {
    it('matches an observation at the exact geofence center', async () => {
      const event = await createEvent(tenantAId, deviceAId, AUSTIN);
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Center',
        ...AUSTIN,
        radiusMeters: 100,
      });

      const res = await evaluate(tokenA, event.id).expect(200);
      const body = res.body as EvaluationBody;

      expect(body.matchCount).toBe(1);
      expect(body.matches[0].geofenceId).toBe(geofence.id);
      expect(body.matches[0].distanceMeters).toBe(0);
    });

    it('matches an observation clearly inside the radius', async () => {
      const inside = await project(AUSTIN, 120, 45);
      const event = await createEvent(tenantAId, deviceAId, inside);
      await createGeofence({
        tenantId: tenantAId,
        name: 'Inside',
        ...AUSTIN,
        radiusMeters: 500,
      });

      const res = await evaluate(tokenA, event.id).expect(200);
      const body = res.body as EvaluationBody;

      expect(body.matchCount).toBe(1);
      expect(body.matches[0].distanceMeters).toBeCloseTo(120, 1);
    });

    it('matches an observation exactly on the configured boundary', async () => {
      const onBoundary = await project(AUSTIN, 250, 90);
      const event = await createEvent(tenantAId, deviceAId, onBoundary);
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Boundary',
        ...AUSTIN,
        radiusMeters: 1,
      });

      // radius := the exact measured distance, so distance == radius bit for bit.
      await setRadiusFromDistance(geofence.id, event.id);

      const distance = await measuredDistance(geofence.id, event.id);
      const stored = await prisma.geofence.findUniqueOrThrow({
        where: { id: geofence.id },
      });
      expect(stored.radiusMeters).toBe(distance);

      const res = await evaluate(tokenA, event.id).expect(200);
      const body = res.body as EvaluationBody;

      // Boundary-inclusive: distance <= radius is inside.
      expect(body.matchCount).toBe(1);
      expect(body.matches[0].geofenceId).toBe(geofence.id);
      expect(body.matches[0].distanceMeters).toBeCloseTo(distance, 3);
    });

    it('excludes an observation one millimeter outside the boundary', async () => {
      const outside = await project(AUSTIN, 250, 90);
      const event = await createEvent(tenantAId, deviceAId, outside);
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Just outside',
        ...AUSTIN,
        radiusMeters: 1,
      });

      await setRadiusFromDistance(geofence.id, event.id, -0.001);

      const res = await evaluate(tokenA, event.id).expect(200);

      expect((res.body as EvaluationBody).matches).toEqual([]);
      expect((res.body as EvaluationBody).matchCount).toBe(0);
    });

    it('includes an observation one millimeter inside the boundary', async () => {
      const nearBoundary = await project(AUSTIN, 250, 90);
      const event = await createEvent(tenantAId, deviceAId, nearBoundary);
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Just inside',
        ...AUSTIN,
        radiusMeters: 1,
      });

      await setRadiusFromDistance(geofence.id, event.id, 0.001);

      const res = await evaluate(tokenA, event.id).expect(200);

      expect((res.body as EvaluationBody).matchCount).toBe(1);
      expect((res.body as EvaluationBody).matches[0].geofenceId).toBe(
        geofence.id,
      );
    });

    it('does not confuse latitude with longitude', async () => {
      // Two geofences whose coordinates are each other's mirror image. Only the
      // one that agrees with the observation on BOTH axes may match.
      const event = await createEvent(tenantAId, deviceAId, {
        latitude: 10,
        longitude: 20,
      });
      const correct = await createGeofence({
        tenantId: tenantAId,
        name: 'Correct order',
        latitude: 10,
        longitude: 20,
        radiusMeters: 1000,
      });
      await createGeofence({
        tenantId: tenantAId,
        name: 'Swapped order',
        latitude: 20,
        longitude: 10,
        radiusMeters: 1000,
      });

      const res = await evaluate(tokenA, event.id).expect(200);
      const body = res.body as EvaluationBody;

      expect(body.matchCount).toBe(1);
      expect(body.matches[0].geofenceId).toBe(correct.id);
      expect(body.matches[0].latitude).toBe(10);
      expect(body.matches[0].longitude).toBe(20);
    });

    it('interprets the radius in meters, not degrees', async () => {
      // At latitude 30, one degree of longitude is roughly 96 km. Both events
      // below are a fraction of a degree away, so a planar degree comparison
      // against a radius of 5000 would match either one.
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Meters',
        latitude: 30,
        longitude: -97,
        radiusMeters: GEOFENCE_RADIUS_MAX_METERS,
      });

      const near = await createEvent(tenantAId, deviceAId, {
        latitude: 30,
        longitude: -96.95, // ~4.8 km
      });
      const far = await createEvent(tenantAId, deviceAId, {
        latitude: 30,
        longitude: -96.9, // ~9.6 km
      });

      const nearBody = (await evaluate(tokenA, near.id).expect(200))
        .body as EvaluationBody;
      const farBody = (await evaluate(tokenA, far.id).expect(200))
        .body as EvaluationBody;

      expect(nearBody.matchCount).toBe(1);
      expect(nearBody.matches[0].geofenceId).toBe(geofence.id);
      expect(nearBody.matches[0].distanceMeters).toBeGreaterThan(4000);
      expect(nearBody.matches[0].distanceMeters).toBeLessThan(5000);

      expect(farBody.matchCount).toBe(0);
    });

    it('behaves correctly well away from the equator', async () => {
      const oslo = { latitude: 59.9139, longitude: 10.7522 };
      await createGeofence({
        tenantId: tenantAId,
        name: 'Oslo',
        ...oslo,
        radiusMeters: 200,
      });

      const inside = await createEvent(
        tenantAId,
        deviceAId,
        await project(oslo, 150, 45),
      );
      const outside = await createEvent(
        tenantAId,
        deviceAId,
        await project(oslo, 250, 45),
      );

      expect(
        ((await evaluate(tokenA, inside.id).expect(200)).body as EvaluationBody)
          .matchCount,
      ).toBe(1);
      expect(
        (
          (await evaluate(tokenA, outside.id).expect(200))
            .body as EvaluationBody
        ).matchCount,
      ).toBe(0);
    });

    it('handles an antimeridian-adjacent pair as a short distance', async () => {
      // 0.0002 degrees apart across the date line: about 22 m on the ground,
      // but nearly 360 degrees apart to any planar comparison.
      await createGeofence({
        tenantId: tenantAId,
        name: 'Antimeridian',
        latitude: 0,
        longitude: 179.9999,
        radiusMeters: 100,
      });

      const event = await createEvent(tenantAId, deviceAId, {
        latitude: 0,
        longitude: -179.9999,
      });

      const body = (await evaluate(tokenA, event.id).expect(200))
        .body as EvaluationBody;

      expect(body.matchCount).toBe(1);
      expect(body.matches[0].distanceMeters).toBeGreaterThan(10);
      expect(body.matches[0].distanceMeters).toBeLessThan(50);
    });

    it('handles near-polar coordinates without failing', async () => {
      const nearPole = { latitude: 89.9995, longitude: 30 };
      await createGeofence({
        tenantId: tenantAId,
        name: 'Near pole',
        ...nearPole,
        radiusMeters: 100,
      });

      const inside = await createEvent(
        tenantAId,
        deviceAId,
        await project(nearPole, 50, 180),
      );
      const outside = await createEvent(
        tenantAId,
        deviceAId,
        await project(nearPole, 200, 180),
      );

      expect(
        ((await evaluate(tokenA, inside.id).expect(200)).body as EvaluationBody)
          .matchCount,
      ).toBe(1);
      expect(
        (
          (await evaluate(tokenA, outside.id).expect(200))
            .body as EvaluationBody
        ).matchCount,
      ).toBe(0);
    });
  });

  describe('filtering and isolation', () => {
    it('matches an active geofence of the caller tenant', async () => {
      const event = await createEvent(tenantAId, deviceAId, AUSTIN);
      const active = await createGeofence({
        tenantId: tenantAId,
        name: 'Active',
        ...AUSTIN,
        radiusMeters: 500,
      });

      const body = (await evaluate(tokenA, event.id).expect(200))
        .body as EvaluationBody;

      expect(body.matches.map((match) => match.geofenceId)).toEqual([
        active.id,
      ]);
    });

    it('excludes an inactive geofence of the caller tenant', async () => {
      const event = await createEvent(tenantAId, deviceAId, AUSTIN);
      await createGeofence({
        tenantId: tenantAId,
        name: 'Deactivated',
        ...AUSTIN,
        radiusMeters: 500,
        isActive: false,
      });

      const body = (await evaluate(tokenA, event.id).expect(200))
        .body as EvaluationBody;

      expect(body.matches).toEqual([]);
      expect(body.matchCount).toBe(0);
    });

    it('excludes an active geofence of another tenant at identical coordinates', async () => {
      const event = await createEvent(tenantAId, deviceAId, AUSTIN);
      const mine = await createGeofence({
        tenantId: tenantAId,
        name: 'Mine',
        ...AUSTIN,
        radiusMeters: 500,
      });
      const theirs = await createGeofence({
        tenantId: tenantBId,
        name: 'Theirs',
        ...AUSTIN,
        radiusMeters: 500,
      });

      const body = (await evaluate(tokenA, event.id).expect(200))
        .body as EvaluationBody;

      expect(body.matches.map((match) => match.geofenceId)).toEqual([mine.id]);
      expect(JSON.stringify(body)).not.toContain(theirs.id);
      expect(JSON.stringify(body)).not.toContain('Theirs');
    });

    it('returns an empty result when only the other tenant owns a containing geofence', async () => {
      const event = await createEvent(tenantAId, deviceAId, AUSTIN);
      await createGeofence({
        tenantId: tenantBId,
        name: 'Theirs only',
        ...AUSTIN,
        radiusMeters: 500,
      });

      const body = (await evaluate(tokenA, event.id).expect(200))
        .body as EvaluationBody;

      expect(body.matchCount).toBe(0);
    });

    it('answers a cross-tenant event id exactly as a nonexistent one', async () => {
      const event = await createEvent(tenantAId, deviceAId, AUSTIN);
      const nonexistent = 'cnonexistent0000000000000';

      const foreign = await evaluate(tokenB, event.id).expect(404);
      const missing = await evaluate(tokenB, nonexistent).expect(404);

      const normalize = (body: ErrorBody) => ({
        statusCode: body.statusCode,
        error: body.error,
        // Only the echoed identifier differs, exactly as on the geofence routes.
        message: String(body.message).replace(/c[a-z0-9]{24}/, '<id>'),
      });

      expect(normalize(foreign.body as ErrorBody)).toEqual(
        normalize(missing.body as ErrorBody),
      );
      expect(JSON.stringify(foreign.body)).not.toContain(tenantAId);
    });

    it('does not let the other tenant evaluate the event even with its own device', async () => {
      const event = await createEvent(tenantBId, deviceBId, AUSTIN);
      await createGeofence({
        tenantId: tenantAId,
        name: 'A only',
        ...AUSTIN,
        radiusMeters: 500,
      });

      // Tenant B owns the event but none of the geofences covering it.
      const body = (await evaluate(tokenB, event.id).expect(200))
        .body as EvaluationBody;
      expect(body.matchCount).toBe(0);

      // Tenant A owns the geofence but not the event.
      await evaluate(tokenA, event.id).expect(404);
    });

    it('rejects a caller whose membership was removed', async () => {
      const temp = await register('evaluation-temp@example.com', 'Tenant Temp');
      const event = await createEvent(tenantAId, deviceAId, AUSTIN);

      await prisma.membership.deleteMany({
        where: { tenantId: temp.tenant.id },
      });

      await evaluate(temp.accessToken, event.id).expect(401);
    });

    it('rejects a missing or malformed token', async () => {
      const event = await createEvent(tenantAId, deviceAId, AUSTIN);

      await request(server)
        .get(`/api/v1/location-events/${event.id}/geofence-evaluation`)
        .expect(401);
      await request(server)
        .get(`/api/v1/location-events/${event.id}/geofence-evaluation`)
        .set('Authorization', 'Bearer forged.token.value')
        .expect(401);
    });

    it('rejects a malformed location-event identifier', async () => {
      const res = await evaluate(tokenA, 'not-a-cuid').expect(400);

      expect((res.body as ErrorBody).message).toBe(
        'Invalid location event id format',
      );
    });
  });

  describe('response behavior', () => {
    it('orders multiple matches by ascending distance', async () => {
      const event = await createEvent(tenantAId, deviceAId, AUSTIN);

      const far = await createGeofence({
        tenantId: tenantAId,
        name: 'Far',
        ...(await project(AUSTIN, 400, 90)),
        radiusMeters: 500,
      });
      const near = await createGeofence({
        tenantId: tenantAId,
        name: 'Near',
        ...(await project(AUSTIN, 50, 90)),
        radiusMeters: 500,
      });
      const middle = await createGeofence({
        tenantId: tenantAId,
        name: 'Middle',
        ...(await project(AUSTIN, 200, 90)),
        radiusMeters: 500,
      });

      const body = (await evaluate(tokenA, event.id).expect(200))
        .body as EvaluationBody;

      expect(body.matches.map((match) => match.geofenceId)).toEqual([
        near.id,
        middle.id,
        far.id,
      ]);

      const distances = body.matches.map((match) => match.distanceMeters);
      expect(distances).toEqual([...distances].sort((a, b) => a - b));
    });

    it('breaks an exact distance tie by ascending geofence id', async () => {
      const event = await createEvent(tenantAId, deviceAId, AUSTIN);

      // Identical centers, so the measured distances are the same double.
      // Created in reverse id order to prove the ordering is not insertion order.
      await createGeofence({
        id: TIE_GEOFENCE_B,
        tenantId: tenantAId,
        name: 'Tie B',
        ...AUSTIN,
        radiusMeters: 500,
      });
      await createGeofence({
        id: TIE_GEOFENCE_A,
        tenantId: tenantAId,
        name: 'Tie A',
        ...AUSTIN,
        radiusMeters: 500,
      });

      const body = (await evaluate(tokenA, event.id).expect(200))
        .body as EvaluationBody;

      expect(body.matches.map((match) => match.geofenceId)).toEqual([
        TIE_GEOFENCE_A,
        TIE_GEOFENCE_B,
      ]);
      expect(body.matches[0].distanceMeters).toBe(
        body.matches[1].distanceMeters,
      );
    });

    it('returns matchCount equal to the array length', async () => {
      const event = await createEvent(tenantAId, deviceAId, AUSTIN);
      for (const name of ['One', 'Two', 'Three']) {
        await createGeofence({
          tenantId: tenantAId,
          name,
          ...AUSTIN,
          radiusMeters: 500,
        });
      }

      const body = (await evaluate(tokenA, event.id).expect(200))
        .body as EvaluationBody;

      expect(body.matchCount).toBe(3);
      expect(body.matchCount).toBe(body.matches.length);
    });

    it('reports the stored observation rather than anything supplied', async () => {
      const event = await createEvent(tenantAId, deviceAId, AUSTIN);

      const body = (await evaluate(tokenA, event.id).expect(200))
        .body as EvaluationBody;

      expect(body).toMatchObject({
        locationEventId: event.id,
        trackedDeviceId: deviceAId,
        observedAt: OBSERVED_AT.toISOString(),
        latitude: AUSTIN.latitude,
        longitude: AUSTIN.longitude,
      });
    });

    it('returns a byte-identical payload for a repeated request', async () => {
      const event = await createEvent(tenantAId, deviceAId, AUSTIN);
      await createGeofence({
        tenantId: tenantAId,
        name: 'Repeatable',
        ...AUSTIN,
        radiusMeters: 500,
      });

      const first = await evaluate(tokenA, event.id).expect(200);
      const second = await evaluate(tokenA, event.id).expect(200);

      expect(JSON.stringify(first.body)).toBe(JSON.stringify(second.body));
    });

    it('serializes distance with the documented millimeter rounding', async () => {
      const observation = await project(AUSTIN, 137.7654321, 33);
      const event = await createEvent(tenantAId, deviceAId, observation);
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Rounded',
        ...AUSTIN,
        radiusMeters: 500,
      });

      const raw = await measuredDistance(geofence.id, event.id);
      const body = (await evaluate(tokenA, event.id).expect(200))
        .body as EvaluationBody;

      expect(body.matches[0].distanceMeters).toBe(
        Math.round(raw * 1000) / 1000,
      );
      // Three decimal places at most.
      expect(
        body.matches[0].distanceMeters.toString().split('.')[1]?.length ?? 0,
      ).toBeLessThanOrEqual(3);
    });

    it('exposes no internal or foreign field', async () => {
      const event = await createEvent(tenantAId, deviceAId, AUSTIN);
      await createGeofence({
        tenantId: tenantAId,
        name: 'Exposure',
        ...AUSTIN,
        radiusMeters: 500,
      });

      const serialized = JSON.stringify(
        (await evaluate(tokenA, event.id).expect(200)).body,
      );

      for (const forbidden of [
        'observedPoint',
        'centerPoint',
        'tenantId',
        'passwordHash',
        'membership',
        'eventKey',
        'receivedAt',
        'accuracyMeters',
        tenantAId,
        tenantBId,
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });
  });

  describe('read-only guarantee', () => {
    it('changes no row in any table', async () => {
      const event = await createEvent(tenantAId, deviceAId, AUSTIN);
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Untouched',
        ...AUSTIN,
        radiusMeters: 500,
      });

      const countsBefore = await rowCounts();
      const geofenceBefore = await prisma.geofence.findUniqueOrThrow({
        where: { id: geofence.id },
      });
      const eventBefore = await prisma.locationEvent.findUniqueOrThrow({
        where: { id: event.id },
      });

      await evaluate(tokenA, event.id).expect(200);
      await evaluate(tokenA, event.id).expect(200);

      // No table gained or lost a row — so no transition, alert, delivery,
      // notification, outbox or audit record was written either.
      expect(await rowCounts()).toEqual(countsBefore);
      expect(
        await prisma.geofence.findUniqueOrThrow({ where: { id: geofence.id } }),
      ).toEqual(geofenceBefore);
      expect(
        await prisma.locationEvent.findUniqueOrThrow({
          where: { id: event.id },
        }),
      ).toEqual(eventBefore);
      expect(await prisma.alertEvent.count()).toBe(0);
    });

    it('creates nothing when the evaluation finds no match', async () => {
      const event = await createEvent(tenantAId, deviceAId, AUSTIN);
      const countsBefore = await rowCounts();

      const body = (await evaluate(tokenA, event.id).expect(200))
        .body as EvaluationBody;

      expect(body.matchCount).toBe(0);
      expect(await rowCounts()).toEqual(countsBefore);
    });
  });

  describe('query posture', () => {
    it('pins the ST_DWithin / ST_Distance disagreement the predicate works around', async () => {
      // The reason containment is ST_Distance(...) <= radius rather than
      // ST_DWithin(...): for geography operands PostGIS measures the two
      // slightly differently, and ST_DWithin is the stricter one. Left as the
      // decision it would exclude a point sitting exactly on the configured
      // radius. If a future PostGIS release makes them agree, this test fails
      // and the workaround can be revisited on evidence rather than on faith.
      const rows = await prisma.$queryRaw<
        Array<{
          distance: number;
          dwithinAtDistance: boolean;
          distanceAtDistance: boolean;
        }>
      >`
        WITH "center" AS (
          SELECT ST_SetSRID(ST_MakePoint(-97.7431, 30.2672), 4326)::geography
                   AS "point"
        ),
        "pair" AS (
          SELECT "center"."point" AS "a",
                 ST_Project("center"."point", 250, radians(90)) AS "b"
          FROM "center"
        )
        SELECT ST_Distance("a", "b") AS "distance",
               ST_DWithin("a", "b", ST_Distance("a", "b")) AS "dwithinAtDistance",
               ST_Distance("a", "b") <= ST_Distance("a", "b")
                 AS "distanceAtDistance"
        FROM "pair"
      `;

      expect(rows[0].distanceAtDistance).toBe(true);
      expect(rows[0].dwithinAtDistance).toBe(false);
      expect(rows[0].distance).toBeCloseTo(250, 6);
    });

    it('caps every stored radius at the constant the bounding prefilter uses', async () => {
      // The prefilter is only a safe superset while the database guarantees no
      // radius exceeds GEOFENCE_RADIUS_MAX_METERS. If a future migration raises
      // the cap, this fails instead of the query silently dropping matches.
      const rows = await prisma.$queryRaw<Array<{ definition: string }>>`
        SELECT pg_get_constraintdef(oid) AS "definition"
        FROM pg_constraint
        WHERE conname = 'Geofence_radiusMeters_max_check'
      `;

      expect(rows).toHaveLength(1);
      expect(rows[0].definition).toContain(String(GEOFENCE_RADIUS_MAX_METERS));
    });

    it('plans the containment statement against the geofence GiST index', async () => {
      const event = await createEvent(tenantAId, deviceAId, AUSTIN);

      // A handful of fixture rows is cheaper to scan than any index, so at that
      // size the planner reasonably ignores every index and the plan says
      // nothing about the query's shape. Seeding a modest, still-small table
      // lets the planner make the choice it would make in production. This is
      // deliberately not an assertion about a specific node count or cost.
      await prisma.geofence.createMany({
        data: Array.from({ length: INDEX_PLAN_FIXTURE_ROWS }, (_, index) => ({
          tenantId: tenantAId,
          name: `Planner fixture ${index}`,
          latitude: 30 + (index % 100) * 0.01,
          longitude: -97 + Math.floor(index / 100) * 0.01,
          radiusMeters: 500,
        })),
      });
      await prisma.$executeRawUnsafe('ANALYZE "Geofence"');

      const plan = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<Record<string, string>>>(
          Prisma.sql`EXPLAIN ${containmentStatement(event.id, tenantAId)}`,
        );
        return rows.map((row) => Object.values(row).join('')).join('\n');
      });

      // The bounding prefilter is served by the GiST index as an expanded
      // bounding-box probe — the access path the index exists for.
      expect(plan).toContain('Geofence_centerPoint_gist_idx');
      expect(plan).toContain('_st_expand');
      // The authoritative predicate is still applied by the database.
      expect(plan).toContain('st_distance');
    });

    it('runs one statement per evaluation regardless of geofence count', async () => {
      const event = await createEvent(tenantAId, deviceAId, AUSTIN);
      for (let index = 0; index < 12; index += 1) {
        await createGeofence({
          tenantId: tenantAId,
          name: `Zone ${index}`,
          ...(await project(AUSTIN, 10 * (index + 1), 90)),
          radiusMeters: 500,
        });
      }

      const stored = await prisma.geofence.count({
        where: { tenantId: tenantAId },
      });
      expect(stored).toBe(12);

      const body = (await evaluate(tokenA, event.id).expect(200))
        .body as EvaluationBody;

      // All twelve are answered by the single spatial statement; nothing here
      // fans out into a query per geofence.
      expect(body.matchCount).toBe(12);
    });
  });
});
