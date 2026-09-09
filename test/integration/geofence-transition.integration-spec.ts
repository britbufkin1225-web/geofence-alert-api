import type { Server } from 'http';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { setupApp } from '../../src/app.setup';
import { GeofenceTransitionService } from '../../src/location-events/geofence-transition.service';
import {
  evaluateAndAdvanceStatement,
  storedStateStatement,
  GeofenceTransitionRow,
  GeofenceStoredStateRow,
} from '../../src/location-events/geofence-transition.query';
import { PrismaService } from '../../src/prisma/prisma.service';
import { requireDisposableDatabaseUrl, truncateAll } from './support/database';

/**
 * REAL PostgreSQL/PostGIS proof for GF-6 deterministic geofence transition
 * detection, driven through the authenticated HTTP ingestion path against the
 * disposable database that `npm run test:db` provisions and migrates.
 *
 * Everything that could be wrong is decided by the database — containment,
 * ordering, whether an observation advances state, and what happens when two
 * observations race — so this is the suite that can prove it. Nothing is mocked
 * anywhere in this file.
 *
 * Boundary fixtures never hand-round a coordinate onto a circle. They place the
 * observation first and then set the radius, in SQL, to the exact double PostGIS
 * measures between the two, so "on the boundary" is an identity.
 */

interface AuthResponse {
  accessToken: string;
  tenant: { id: string; name: string };
}

interface TransitionBody {
  geofenceId: string;
  name: string;
  radiusMeters: number;
  distanceMeters: number;
  state: 'INSIDE' | 'OUTSIDE';
  transition:
    | 'BASELINE_INSIDE'
    | 'BASELINE_OUTSIDE'
    | 'ENTER'
    | 'EXIT'
    | 'STAY_INSIDE'
    | 'STAY_OUTSIDE';
  stateAdvanced: boolean;
}

interface EventBody {
  id: string;
  tenantId: string;
  trackedDeviceId: string;
  eventKey: string;
  observedAt: string;
  replayed: boolean;
  geofenceTransitions: TransitionBody[];
}

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
}

// Austin, TX. Latitude and longitude differ in sign and magnitude, so a swapped
// axis order cannot accidentally still pass.
const AUSTIN = { latitude: 30.2672, longitude: -97.7431 };

// Roughly 11 km north of AUSTIN: far outside a 250 m circle, and far outside the
// 5,001 m prefilter GF-5 uses, so a geofence the device has left is still
// evaluated here.
const FAR = { latitude: 30.3672, longitude: -97.7431 };

const BASE_TIME = Date.parse('2026-09-09T06:00:00.000Z');

/** Distinct observation instants, minutes apart, in a fixed order. */
const at = (minutes: number) => new Date(BASE_TIME + minutes * 60_000);

describe('GF-6 geofence transition detection (real PostgreSQL/PostGIS integration)', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;

  let tokenA: string;
  let tokenB: string;
  let tenantAId: string;
  let tenantBId: string;

  let eventSeq = 0;

  const register = async (email: string, tenantName: string) => {
    const res = await request(server)
      .post('/api/v1/auth/register')
      .send({ email, password: 'password-Aa1', tenantName })
      .expect(201);
    return res.body as AuthResponse;
  };

  const registerDevice = async (token: string, deviceKey: string) => {
    const res = await request(server)
      .post('/api/v1/tracked-devices')
      .set('Authorization', `Bearer ${token}`)
      .send({ deviceKey, name: `Van ${deviceKey}` })
      .expect(201);
    return (res.body as { id: string }).id;
  };

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

  /** Ingests one observation over HTTP and returns the parsed response body. */
  const ingest = async (
    token: string,
    options: {
      deviceKey: string;
      coordinates: { latitude: number; longitude: number };
      observedAt: Date;
      eventKey?: string;
      expect?: number;
    },
  ): Promise<EventBody> => {
    const res = await request(server)
      .post('/api/v1/location-events')
      .set('Authorization', `Bearer ${token}`)
      .send({
        deviceKey: options.deviceKey,
        eventKey: options.eventKey ?? `evt-${++eventSeq}`,
        observedAt: options.observedAt.toISOString(),
        latitude: options.coordinates.latitude,
        longitude: options.coordinates.longitude,
        accuracyMeters: 5,
      })
      .expect(options.expect ?? 201);
    return res.body as EventBody;
  };

  /** The single transition entry for one geofence, asserted to exist. */
  const transitionFor = (body: EventBody, geofenceId: string) => {
    const match = body.geofenceTransitions.find(
      (entry) => entry.geofenceId === geofenceId,
    );
    expect(match).toBeDefined();
    return match as TransitionBody;
  };

  const stateRow = (
    tenantId: string,
    trackedDeviceId: string,
    geofenceId: string,
  ) =>
    prisma.geofenceDeviceState.findUnique({
      where: {
        tenantId_trackedDeviceId_geofenceId: {
          tenantId,
          trackedDeviceId,
          geofenceId,
        },
      },
    });

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

    const a = await register('transition-a@example.com', 'Tenant A');
    const b = await register('transition-b@example.com', 'Tenant B');
    tokenA = a.accessToken;
    tokenB = b.accessToken;
    tenantAId = a.tenant.id;
    tenantBId = b.tenant.id;
  });

  afterAll(async () => {
    if (app) {
      await truncateAll(prisma);
      await app.close();
    }
  });

  /**
   * Each test owns its geofences, devices and state. Truncating identities too
   * would invalidate the tokens issued once above, so only the domain tables the
   * transition path touches are cleared.
   */
  beforeEach(async () => {
    requireDisposableDatabaseUrl();
    await prisma.$executeRaw`TRUNCATE TABLE "GeofenceDeviceState", "LocationEvent", "TrackedDevice", "Geofence" RESTART IDENTITY CASCADE`;
  });

  describe('classification', () => {
    it('baselines the first observation inside a geofence without claiming an entry', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');

      const body = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
      });

      const transition = transitionFor(body, geofence.id);
      expect(transition.state).toBe('INSIDE');
      expect(transition.transition).toBe('BASELINE_INSIDE');
      expect(transition.stateAdvanced).toBe(true);
    });

    it('baselines the first observation outside a geofence without claiming an exit', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');

      const body = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: FAR,
        observedAt: at(0),
      });

      const transition = transitionFor(body, geofence.id);
      expect(transition.state).toBe('OUTSIDE');
      expect(transition.transition).toBe('BASELINE_OUTSIDE');
      expect(transition.stateAdvanced).toBe(true);
    });

    it('classifies outside then inside as ENTER', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');

      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: FAR,
        observedAt: at(0),
      });
      const body = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(1),
      });

      const transition = transitionFor(body, geofence.id);
      expect(transition.transition).toBe('ENTER');
      expect(transition.state).toBe('INSIDE');
      expect(transition.stateAdvanced).toBe(true);
    });

    it('classifies inside then outside as EXIT', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');

      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
      });
      const body = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: FAR,
        observedAt: at(1),
      });

      const transition = transitionFor(body, geofence.id);
      expect(transition.transition).toBe('EXIT');
      expect(transition.state).toBe('OUTSIDE');
    });

    it('classifies inside then inside as STAY_INSIDE', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');

      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
      });
      const body = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: { latitude: 30.2673, longitude: -97.7432 },
        observedAt: at(1),
      });

      expect(transitionFor(body, geofence.id).transition).toBe('STAY_INSIDE');
    });

    it('classifies outside then outside as STAY_OUTSIDE', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');

      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: FAR,
        observedAt: at(0),
      });
      const body = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: { latitude: 30.4672, longitude: -97.7431 },
        observedAt: at(1),
      });

      expect(transitionFor(body, geofence.id).transition).toBe('STAY_OUTSIDE');
    });

    it('treats an observation exactly on the boundary as inside', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');

      // Place the observation first, then make the radius exactly the distance
      // PostGIS measures to it. Nothing is rounded onto the circle.
      const boundary = { latitude: 30.2712, longitude: -97.7431 };
      const first = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: boundary,
        observedAt: at(0),
      });
      expect(transitionFor(first, geofence.id).state).toBe('OUTSIDE');

      await setRadiusFromDistance(geofence.id, first.id, 0);

      const second = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: boundary,
        observedAt: at(1),
      });

      const transition = transitionFor(second, geofence.id);
      expect(transition.state).toBe('INSIDE');
      // The boundary belongs to INSIDE, so arriving on it from outside is a real
      // crossing rather than a STAY_OUTSIDE.
      expect(transition.transition).toBe('ENTER');
    });
  });

  describe('state advancement', () => {
    it('creates exactly one state row per tenant, device and geofence', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');

      for (const minute of [0, 1, 2, 3]) {
        await ingest(tokenA, {
          deviceKey: 'device-1',
          coordinates: minute % 2 === 0 ? AUSTIN : FAR,
          observedAt: at(minute),
        });
      }

      const rows = await prisma.geofenceDeviceState.findMany({
        where: { tenantId: tenantAId, geofenceId: geofence.id },
      });
      expect(rows).toHaveLength(1);
    });

    it('advances the stored state, source event and observation instant', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');

      const first = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
      });
      const afterFirst = await stateRow(tenantAId, deviceId, geofence.id);
      expect(afterFirst?.state).toBe('INSIDE');
      expect(afterFirst?.lastTransition).toBe('BASELINE_INSIDE');
      expect(afterFirst?.lastLocationEventId).toBe(first.id);
      expect(afterFirst?.lastObservedAt.toISOString()).toBe(
        at(0).toISOString(),
      );

      const second = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: FAR,
        observedAt: at(5),
      });
      const afterSecond = await stateRow(tenantAId, deviceId, geofence.id);
      expect(afterSecond?.state).toBe('OUTSIDE');
      expect(afterSecond?.lastTransition).toBe('EXIT');
      expect(afterSecond?.lastLocationEventId).toBe(second.id);
      expect(afterSecond?.lastObservedAt.toISOString()).toBe(
        at(5).toISOString(),
      );
    });

    it('never stores a distance as state', async () => {
      await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');
      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
      });

      const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'GeofenceDeviceState'
      `;
      const names = columns.map((column) => column.column_name);

      expect(names).not.toContain('distanceMeters');
      expect(names).not.toContain('latitude');
      expect(names).not.toContain('longitude');
    });

    it('keeps the state of two devices independent', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceOne = await registerDevice(tokenA, 'device-1');
      const deviceTwo = await registerDevice(tokenA, 'device-2');

      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
      });
      const other = await ingest(tokenA, {
        deviceKey: 'device-2',
        coordinates: FAR,
        observedAt: at(1),
      });

      // The second device has never been seen before; it baselines rather than
      // inheriting the first device's INSIDE state as an EXIT.
      expect(transitionFor(other, geofence.id).transition).toBe(
        'BASELINE_OUTSIDE',
      );
      expect((await stateRow(tenantAId, deviceOne, geofence.id))?.state).toBe(
        'INSIDE',
      );
      expect((await stateRow(tenantAId, deviceTwo, geofence.id))?.state).toBe(
        'OUTSIDE',
      );
    });

    it('keeps the state of two geofences independent', async () => {
      const near = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const wide = await createGeofence({
        tenantId: tenantAId,
        name: 'City',
        ...AUSTIN,
        radiusMeters: 5000,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');

      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
      });
      // 1 km north: outside the 250 m circle, still inside the 5 km one.
      const body = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: { latitude: 30.2762, longitude: -97.7431 },
        observedAt: at(1),
      });

      expect(transitionFor(body, near.id).transition).toBe('EXIT');
      expect(transitionFor(body, wide.id).transition).toBe('STAY_INSIDE');
      expect((await stateRow(tenantAId, deviceId, near.id))?.state).toBe(
        'OUTSIDE',
      );
      expect((await stateRow(tenantAId, deviceId, wide.id))?.state).toBe(
        'INSIDE',
      );
    });

    it('keeps the state of two tenants independent at identical coordinates', async () => {
      const geofenceA = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const geofenceB = await createGeofence({
        tenantId: tenantBId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      // The same external device key in both tenants: tenant-scoped identifiers
      // must not collide into one another's state.
      const deviceA = await registerDevice(tokenA, 'shared-key');
      const deviceB = await registerDevice(tokenB, 'shared-key');

      await ingest(tokenA, {
        deviceKey: 'shared-key',
        coordinates: AUSTIN,
        observedAt: at(0),
      });
      const bodyB = await ingest(tokenB, {
        deviceKey: 'shared-key',
        coordinates: FAR,
        observedAt: at(1),
      });

      expect(
        bodyB.geofenceTransitions.map((entry) => entry.geofenceId),
      ).toEqual([geofenceB.id]);
      expect(transitionFor(bodyB, geofenceB.id).transition).toBe(
        'BASELINE_OUTSIDE',
      );

      expect((await stateRow(tenantAId, deviceA, geofenceA.id))?.state).toBe(
        'INSIDE',
      );
      expect((await stateRow(tenantBId, deviceB, geofenceB.id))?.state).toBe(
        'OUTSIDE',
      );
      expect(await stateRow(tenantAId, deviceA, geofenceB.id)).toBeNull();
      expect(await stateRow(tenantBId, deviceB, geofenceA.id)).toBeNull();
    });
  });

  describe('ordering and idempotency', () => {
    it('does not let an older observation regress state', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');

      const newest = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(10),
      });

      const stale = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: FAR,
        observedAt: at(1),
      });

      const transition = transitionFor(stale, geofence.id);
      expect(transition.stateAdvanced).toBe(false);
      // The stale observation is outside, and says so, but it is not evidence of
      // an exit and is never reported as one.
      expect(transition.state).toBe('OUTSIDE');
      expect(transition.transition).toBe('STAY_OUTSIDE');

      const row = await stateRow(tenantAId, deviceId, geofence.id);
      expect(row?.state).toBe('INSIDE');
      expect(row?.lastLocationEventId).toBe(newest.id);
      expect(row?.lastObservedAt.toISOString()).toBe(at(10).toISOString());
    });

    it('breaks an equal-instant tie by event id, whichever order the events arrive', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');

      const first = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
      });
      const second = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: FAR,
        observedAt: at(0),
      });

      const winner = first.id > second.id ? first : second;
      const loser = first.id > second.id ? second : first;
      const row = await stateRow(tenantAId, deviceId, geofence.id);

      // The greater event id owns the state regardless of which arrived first.
      expect(row?.lastLocationEventId).toBe(winner.id);
      expect(row?.lastLocationEventId).not.toBe(loser.id);
      expect(row?.lastObservedAt.toISOString()).toBe(at(0).toISOString());
    });

    it('converges on the same state when equal-instant events arrive in the reverse order', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');

      // Two events with ids fixed in advance, ingested newest-id first.
      const high = 'cgf6state000000000000000b';
      const low = 'cgf6state000000000000000a';

      const seed = async (id: string, coordinates: typeof AUSTIN) => {
        const event = await prisma.locationEvent.create({
          data: {
            id,
            tenantId: tenantAId,
            trackedDeviceId: deviceId,
            eventKey: `tie-${id}`,
            observedAt: at(0),
            latitude: coordinates.latitude,
            longitude: coordinates.longitude,
            accuracyMeters: 5,
          },
        });
        return event.id;
      };

      await seed(high, FAR);
      await seed(low, AUSTIN);

      // Resolved from the running application, so this is the same instance the
      // HTTP path uses.
      const service = app.get(GeofenceTransitionService);

      await service.evaluate(high, tenantAId);
      await service.evaluate(low, tenantAId);

      const row = await stateRow(tenantAId, deviceId, geofence.id);
      expect(row?.lastLocationEventId).toBe(high);
      expect(row?.state).toBe('OUTSIDE');
      await prisma.geofenceDeviceState.deleteMany({
        where: { tenantId: tenantAId },
      });
      await service.evaluate(low, tenantAId);
      await service.evaluate(high, tenantAId);
      expect(await stateRow(tenantAId, deviceId, geofence.id)).toMatchObject({
        lastLocationEventId: high,
        state: 'OUTSIDE',
        lastTransition: 'EXIT',
      });
      await prisma.geofenceDeviceState.deleteMany({
        where: { tenantId: tenantAId },
      });
      await Promise.all(
        [high, low, high, low, high, low].map((id) =>
          service.evaluate(id, tenantAId),
        ),
      );
      expect(await stateRow(tenantAId, deviceId, geofence.id)).toMatchObject({
        lastLocationEventId: high,
        state: 'OUTSIDE',
      });
    });

    it('does not advance state twice when an idempotent event is replayed', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');

      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: FAR,
        observedAt: at(0),
        eventKey: 'evt-outside',
      });
      const entered = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(1),
        eventKey: 'evt-inside',
      });
      expect(transitionFor(entered, geofence.id).transition).toBe('ENTER');

      const before = await stateRow(tenantAId, deviceId, geofence.id);

      const replay = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(1),
        eventKey: 'evt-inside',
        expect: 200,
      });

      expect(replay.replayed).toBe(true);
      const transition = transitionFor(replay, geofence.id);
      // The replay repeats the crossing it originally described rather than
      // inventing a second one, and it changes nothing.
      expect(transition.transition).toBe('ENTER');
      expect(transition.stateAdvanced).toBe(false);

      const after = await stateRow(tenantAId, deviceId, geofence.id);
      expect(after?.lastLocationEventId).toBe(before?.lastLocationEventId);
      expect(after?.updatedAt.toISOString()).toBe(
        before?.updatedAt.toISOString(),
      );
      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: FAR,
        observedAt: at(2),
      });
      const superseding = await stateRow(tenantAId, deviceId, geofence.id);
      const supersededReplay = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(1),
        eventKey: 'evt-inside',
        expect: 200,
      });
      expect(transitionFor(supersededReplay, geofence.id)).toMatchObject({
        state: 'INSIDE',
        transition: 'STAY_INSIDE',
        stateAdvanced: false,
      });
      expect(await stateRow(tenantAId, deviceId, geofence.id)).toEqual(
        superseding,
      );
    });

    it('does not fabricate a crossing for a later event at the same coordinates', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');

      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
      });
      const duplicate = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(1),
      });

      const transition = transitionFor(duplicate, geofence.id);
      expect(transition.transition).toBe('STAY_INSIDE');
      expect(transition.stateAdvanced).toBe(true);
    });

    it('does not let a stale event overwrite the stored source-event reference', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');

      const newest = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(10),
      });
      for (const minute of [1, 2, 3]) {
        await ingest(tokenA, {
          deviceKey: 'device-1',
          coordinates: FAR,
          observedAt: at(minute),
        });
      }

      const row = await stateRow(tenantAId, deviceId, geofence.id);
      expect(row?.lastLocationEventId).toBe(newest.id);
      expect(row?.state).toBe('INSIDE');
    });

    it('rejects a reused event key carrying different data without touching state', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');

      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
        eventKey: 'evt-conflict',
      });
      const before = await stateRow(tenantAId, deviceId, geofence.id);

      const res = await request(server)
        .post('/api/v1/location-events')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          deviceKey: 'device-1',
          eventKey: 'evt-conflict',
          observedAt: at(9).toISOString(),
          latitude: FAR.latitude,
          longitude: FAR.longitude,
          accuracyMeters: 5,
        })
        .expect(409);

      expect((res.body as ErrorBody).statusCode).toBe(409);

      const after = await stateRow(tenantAId, deviceId, geofence.id);
      expect(after?.state).toBe('INSIDE');
      expect(after?.lastLocationEventId).toBe(before?.lastLocationEventId);
      expect(after?.updatedAt.toISOString()).toBe(
        before?.updatedAt.toISOString(),
      );
    });
  });

  describe('authorization and isolation', () => {
    it('rejects foreign and injection-shaped inputs at the raw-query boundary', async () => {
      // Both tenants must have applicable geofences: otherwise removing the
      // event tenant predicate could still return [] for the wrong reason.
      await createGeofence({
        tenantId: tenantBId,
        name: 'Other tenant depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');
      const event = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
      });
      const before = await stateRow(tenantAId, deviceId, geofence.id);
      const service = app.get(GeofenceTransitionService);
      for (const [eventId, tenantId] of [
        [event.id, tenantBId],
        ["' OR TRUE --", tenantAId],
        [event.id, "' OR TRUE --"],
        ['invalid-id', tenantAId],
      ]) {
        await expect(service.evaluate(eventId, tenantId)).resolves.toEqual([]);
      }
      expect(await stateRow(tenantAId, deviceId, geofence.id)).toEqual(before);
      const foreignDevice = await registerDevice(tokenB, 'device-1');
      const foreignEvent = await ingest(tokenB, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
      });
      for (const data of [
        { trackedDeviceId: foreignDevice },
        { lastLocationEventId: foreignEvent.id },
      ]) {
        await expect(
          prisma.geofenceDeviceState.update({
            where: {
              tenantId_trackedDeviceId_geofenceId: {
                tenantId: tenantAId,
                trackedDeviceId: deviceId,
                geofenceId: geofence.id,
              },
            },
            data,
          }),
        ).rejects.toMatchObject({ code: 'P2003' });
      }
      expect(await stateRow(tenantAId, deviceId, geofence.id)).toEqual(before);
    });

    it('writes no state for an unauthenticated submission', async () => {
      await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');

      await request(server)
        .post('/api/v1/location-events')
        .send({
          deviceKey: 'device-1',
          eventKey: 'evt-anonymous',
          observedAt: at(0).toISOString(),
          latitude: AUSTIN.latitude,
          longitude: AUSTIN.longitude,
          accuracyMeters: 5,
        })
        .expect(401);

      expect(await prisma.geofenceDeviceState.count()).toBe(0);
    });

    it('writes no state once the membership behind a valid token is gone', async () => {
      await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');

      const memberships = await prisma.membership.findMany({
        where: { tenantId: tenantAId },
      });
      await prisma.membership.deleteMany({ where: { tenantId: tenantAId } });

      await request(server)
        .post('/api/v1/location-events')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          deviceKey: 'device-1',
          eventKey: 'evt-no-membership',
          observedAt: at(0).toISOString(),
          latitude: AUSTIN.latitude,
          longitude: AUSTIN.longitude,
          accuracyMeters: 5,
        })
        .expect(401);

      expect(await prisma.geofenceDeviceState.count()).toBe(0);

      // Restore the membership the shared token depends on.
      await prisma.membership.createMany({ data: memberships });
    });

    it('writes no state for a device the caller does not own', async () => {
      await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenB, 'tenant-b-device');

      await ingest(tokenA, {
        deviceKey: 'tenant-b-device',
        coordinates: AUSTIN,
        observedAt: at(0),
        expect: 404,
      });

      expect(await prisma.geofenceDeviceState.count()).toBe(0);
    });

    it('never reads or modifies another tenant state for the same geofence coordinates', async () => {
      const geofenceA = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const geofenceB = await createGeofence({
        tenantId: tenantBId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceA = await registerDevice(tokenA, 'device-a');
      await registerDevice(tokenB, 'device-b');

      await ingest(tokenA, {
        deviceKey: 'device-a',
        coordinates: AUSTIN,
        observedAt: at(0),
      });
      const beforeA = await stateRow(tenantAId, deviceA, geofenceA.id);

      const bodyB = await ingest(tokenB, {
        deviceKey: 'device-b',
        coordinates: FAR,
        observedAt: at(1),
      });

      // Tenant B's evaluation sees only tenant B's geofence.
      expect(bodyB.geofenceTransitions).toHaveLength(1);
      expect(bodyB.geofenceTransitions[0].geofenceId).toBe(geofenceB.id);

      const afterA = await stateRow(tenantAId, deviceA, geofenceA.id);
      expect(afterA?.state).toBe('INSIDE');
      expect(afterA?.updatedAt.toISOString()).toBe(
        beforeA?.updatedAt.toISOString(),
      );
    });

    it('refuses a state row whose tenant disagrees with its geofence', async () => {
      const geofenceB = await createGeofence({
        tenantId: tenantBId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceA = await registerDevice(tokenA, 'device-a');
      const event = await ingest(tokenA, {
        deviceKey: 'device-a',
        coordinates: AUSTIN,
        observedAt: at(0),
      });

      // The composite foreign keys make cross-tenant state structurally
      // impossible, not merely avoided by the query predicates.
      await expect(
        prisma.geofenceDeviceState.create({
          data: {
            tenantId: tenantAId,
            trackedDeviceId: deviceA,
            geofenceId: geofenceB.id,
            state: 'INSIDE',
            lastTransition: 'BASELINE_INSIDE',
            lastLocationEventId: event.id,
            lastObservedAt: at(0),
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('geofence applicability', () => {
    it('rolls back deactivation if state retirement fails', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');
      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
      });
      await prisma.$executeRaw`ALTER TABLE "GeofenceDeviceState" RENAME TO "GeofenceDeviceState_hidden"`;
      try {
        const response = await request(server)
          .patch(`/api/v1/geofences/${geofence.id}`)
          .set('Authorization', `Bearer ${tokenA}`)
          .send({ isActive: false })
          .expect(500);
        expect((response.body as ErrorBody).message).toBe(
          'Internal server error',
        );
        expect(
          (
            await prisma.geofence.findUniqueOrThrow({
              where: { id: geofence.id },
            })
          ).isActive,
        ).toBe(true);
      } finally {
        await prisma.$executeRaw`ALTER TABLE "GeofenceDeviceState_hidden" RENAME TO "GeofenceDeviceState"`;
      }
      expect(await prisma.geofenceDeviceState.count()).toBe(1);
    });

    it('excludes an inactive geofence from evaluation', async () => {
      const active = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const inactive = await createGeofence({
        tenantId: tenantAId,
        name: 'Retired',
        ...AUSTIN,
        radiusMeters: 500,
        isActive: false,
      });
      await registerDevice(tokenA, 'device-1');

      const body = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
      });

      expect(body.geofenceTransitions.map((entry) => entry.geofenceId)).toEqual(
        [active.id],
      );
      expect(
        await prisma.geofenceDeviceState.count({
          where: { geofenceId: inactive.id },
        }),
      ).toBe(0);
    });

    it('does not report an EXIT when a geofence is deactivated under a device that is inside', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');

      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
      });

      await request(server)
        .patch(`/api/v1/geofences/${geofence.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ isActive: false })
        .expect(200);

      const body = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(1),
      });

      expect(body.geofenceTransitions).toEqual([]);
      // Deactivation retires the state rather than leaving a stale INSIDE that a
      // reactivation would later resolve into an unobserved crossing.
      expect(await stateRow(tenantAId, deviceId, geofence.id)).toBeNull();
    });

    it('baselines the first observation after a geofence is re-enabled', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');

      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
      });

      const patch = (isActive: boolean) =>
        request(server)
          .patch(`/api/v1/geofences/${geofence.id}`)
          .set('Authorization', `Bearer ${tokenA}`)
          .send({ isActive })
          .expect(200);

      const before = await prisma.geofenceDeviceState.findMany();
      await request(server)
        .patch(`/api/v1/geofences/${geofence.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Renamed' })
        .expect(200);
      expect(await prisma.geofenceDeviceState.findMany()).toEqual(before);
      await patch(false);
      await patch(false);
      await patch(true);

      const body = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: FAR,
        observedAt: at(2),
      });

      const transition = transitionFor(body, geofence.id);
      expect(transition.transition).toBe('BASELINE_OUTSIDE');
      expect(transition.stateAdvanced).toBe(true);
    });

    it('retires only the deactivated geofence state, and only inside its tenant', async () => {
      const retired = await createGeofence({
        tenantId: tenantAId,
        name: 'Retiring',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const kept = await createGeofence({
        tenantId: tenantAId,
        name: 'Kept',
        ...AUSTIN,
        radiusMeters: 5000,
      });
      const geofenceB = await createGeofence({
        tenantId: tenantBId,
        name: 'Other tenant',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceA = await registerDevice(tokenA, 'device-a');
      const deviceB = await registerDevice(tokenB, 'device-b');

      await ingest(tokenA, {
        deviceKey: 'device-a',
        coordinates: AUSTIN,
        observedAt: at(0),
      });
      await ingest(tokenB, {
        deviceKey: 'device-b',
        coordinates: AUSTIN,
        observedAt: at(0),
      });

      await request(server)
        .patch(`/api/v1/geofences/${retired.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ isActive: false })
        .expect(200);

      expect(await stateRow(tenantAId, deviceA, retired.id)).toBeNull();
      expect(await stateRow(tenantAId, deviceA, kept.id)).not.toBeNull();
      expect(await stateRow(tenantBId, deviceB, geofenceB.id)).not.toBeNull();
    });

    it('orders transitions by distance and then by geofence id', async () => {
      // Ids that differ only in their last character, so the tie-break is
      // unambiguous under any collation.
      const tieA = 'cgf6tie00000000000000001a';
      const tieB = 'cgf6tie00000000000000001b';

      await createGeofence({
        id: tieB,
        tenantId: tenantAId,
        name: 'Tie B',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await createGeofence({
        id: tieA,
        tenantId: tenantAId,
        name: 'Tie A',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const far = await createGeofence({
        tenantId: tenantAId,
        name: 'Far',
        latitude: 30.2772,
        longitude: -97.7431,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');

      const body = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
      });

      // Equal distance (both centers are the observation) sorts by id; the
      // distant circle follows.
      expect(body.geofenceTransitions.map((entry) => entry.geofenceId)).toEqual(
        [tieA, tieB, far.id],
      );
      expect(body.geofenceTransitions.map((entry) => entry.state)).toEqual([
        'INSIDE',
        'INSIDE',
        'OUTSIDE',
      ]);
    });

    it('leaves the GF-5 evaluation endpoint read-only and unchanged', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');

      const event = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
      });
      const before = await stateRow(tenantAId, deviceId, geofence.id);

      const res = await request(server)
        .get(`/api/v1/location-events/${event.id}/geofence-evaluation`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      const body = res.body as {
        matches: Array<{ geofenceId: string }>;
        matchCount: number;
      };
      expect(body.matchCount).toBe(1);
      expect(body.matches[0].geofenceId).toBe(geofence.id);
      // GF-5 stays a pure read: evaluating does not advance transition state.
      expect(JSON.stringify(body)).not.toContain('transition');

      const after = await stateRow(tenantAId, deviceId, geofence.id);
      expect(after?.updatedAt.toISOString()).toBe(
        before?.updatedAt.toISOString(),
      );
      expect(after?.lastLocationEventId).toBe(before?.lastLocationEventId);
    });
  });

  describe('concurrency and error safety', () => {
    it('lets ingestion finish before deactivation retires its state', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');
      const event = await prisma.locationEvent.create({
        data: {
          tenantId: tenantAId,
          trackedDeviceId: deviceId,
          eventKey: 'ingestion-first',
          observedAt: at(0),
          accuracyMeters: 5,
          ...AUSTIN,
        },
      });
      let deactivation: Promise<request.Response> | undefined;
      try {
        await prisma.$transaction(
          async (tx) => {
            const [holder] = await tx.$queryRaw<
              Array<{ pid: number }>
            >`SELECT pg_backend_pid() AS pid`;
            const rows = await tx.$queryRaw<GeofenceTransitionRow[]>(
              evaluateAndAdvanceStatement(event.id, tenantAId),
            );
            expect(rows[0].advancedTransition).toBe('BASELINE_INSIDE');
            deactivation = request(server)
              .patch(`/api/v1/geofences/${geofence.id}`)
              .set('Authorization', `Bearer ${tokenA}`)
              .send({ isActive: false })
              .then((response) => response);
            const deadline = Date.now() + 4000;
            for (;;) {
              const [lock] = await prisma.$queryRaw<
                Array<{ blocked: boolean }>
              >`
              SELECT EXISTS (
                SELECT 1 FROM pg_stat_activity
                WHERE datname = current_database()
                  AND query LIKE 'UPDATE%"Geofence"%'
                  AND ${holder.pid}::integer = ANY(pg_blocking_pids(pid))
              ) AS blocked
            `;
              if (lock.blocked) break;
              if (Date.now() > deadline)
                throw new Error(
                  'Deactivation did not wait on the geofence lock',
                );
            }
            expect(await tx.geofenceDeviceState.count()).toBe(1);
          },
          { timeout: 10000 },
        );
      } finally {
        if (deactivation) expect((await deactivation).status).toBe(200);
      }
      expect(await stateRow(tenantAId, deviceId, geofence.id)).toBeNull();
      await request(server)
        .patch(`/api/v1/geofences/${geofence.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ isActive: true })
        .expect(200);
      const next = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: FAR,
        observedAt: at(1),
      });
      expect(transitionFor(next, geofence.id).transition).toBe(
        'BASELINE_OUTSIDE',
      );
    });

    it('rolls back all geofence advancement when one state write violates a constraint', async () => {
      await createGeofence({
        tenantId: tenantAId,
        name: 'First',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await createGeofence({
        tenantId: tenantAId,
        name: 'Second',
        ...AUSTIN,
        radiusMeters: 500,
      });
      await registerDevice(tokenA, 'device-1');
      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
      });
      const before = await prisma.geofenceDeviceState.findMany({
        orderBy: { geofenceId: 'asc' },
      });
      await prisma.$executeRaw`ALTER TABLE "GeofenceDeviceState" ADD CONSTRAINT gf6_audit_failure CHECK ("state" <> 'OUTSIDE')`;
      try {
        await ingest(tokenA, {
          deviceKey: 'device-1',
          eventKey: 'constraint-failure',
          coordinates: FAR,
          observedAt: at(1),
          expect: 500,
        });
        expect(
          await prisma.geofenceDeviceState.findMany({
            orderBy: { geofenceId: 'asc' },
          }),
        ).toEqual(before);
        expect(
          await prisma.locationEvent.count({
            where: { eventKey: 'constraint-failure' },
          }),
        ).toBe(1);
      } finally {
        await prisma.$executeRaw`ALTER TABLE "GeofenceDeviceState" DROP CONSTRAINT gf6_audit_failure`;
      }
      const repaired = await ingest(tokenA, {
        deviceKey: 'device-1',
        eventKey: 'constraint-failure',
        coordinates: FAR,
        observedAt: at(1),
        expect: 200,
      });
      expect(repaired.geofenceTransitions).toHaveLength(2);
      expect(
        repaired.geofenceTransitions.every(
          (row) => row.transition === 'EXIT' && row.stateAdvanced,
        ),
      ).toBe(true);
    });

    it.each(['replay', 'stale'] as const)(
      'holds the %s conflict lock through the stored-state read',
      async (kind) => {
        const geofence = await createGeofence({
          tenantId: tenantAId,
          name: 'Depot',
          ...AUSTIN,
          radiusMeters: 250,
        });
        const deviceId = await registerDevice(tokenA, 'device-1');
        const older = await ingest(tokenA, {
          deviceKey: 'device-1',
          coordinates: FAR,
          observedAt: at(0),
        });
        const owner = await ingest(tokenA, {
          deviceKey: 'device-1',
          coordinates: AUSTIN,
          observedAt: at(1),
        });
        const next = await prisma.locationEvent.create({
          data: {
            tenantId: tenantAId,
            trackedDeviceId: deviceId,
            eventKey: 'next',
            observedAt: at(2),
            ...FAR,
            accuracyMeters: 5,
          },
        });
        const inputId = kind === 'replay' ? owner.id : older.id;
        let competing!: Promise<unknown>;
        await prisma.$transaction(
          async (tx) => {
            const [holder] = await tx.$queryRaw<
              Array<{ pid: number }>
            >`SELECT pg_backend_pid() AS pid`;
            const rows = await tx.$queryRaw<GeofenceTransitionRow[]>(
              evaluateAndAdvanceStatement(inputId, tenantAId),
            );
            expect(rows[0].advancedTransition).toBeNull();
            competing = app
              .get(GeofenceTransitionService)
              .evaluate(next.id, tenantAId);
            const deadline = Date.now() + 4000;
            for (;;) {
              const [lock] = await prisma.$queryRaw<
                Array<{ blocked: boolean }>
              >`
              SELECT EXISTS (
                SELECT 1 FROM pg_stat_activity
                WHERE pid <> pg_backend_pid()
                  AND query LIKE '%WITH "evaluated" AS%'
                  AND ${holder.pid}::integer = ANY(pg_blocking_pids(pid))
              ) AS blocked
            `;
              if (lock.blocked) break;
              if (Date.now() > deadline)
                throw new Error('Writer did not block on resolved state');
            }
            const stored = await tx.$queryRaw<GeofenceStoredStateRow[]>(
              storedStateStatement(inputId, tenantAId, [geofence.id]),
            );
            expect(stored).toEqual([
              {
                geofenceId: geofence.id,
                lastLocationEventId: owner.id,
                lastTransition: 'ENTER',
              },
            ]);
          },
          { timeout: 10000 },
        );
        await competing;
        expect(
          (await stateRow(tenantAId, deviceId, geofence.id))
            ?.lastLocationEventId,
        ).toBe(next.id);
      },
    );

    it('does not recreate retired state while deactivation is committing', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');
      const event = await prisma.locationEvent.create({
        data: {
          tenantId: tenantAId,
          trackedDeviceId: deviceId,
          eventKey: 'during-deactivation',
          observedAt: at(0),
          accuracyMeters: 5,
          ...AUSTIN,
        },
      });
      let release!: () => void;
      let ready!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const locked = new Promise<void>((resolve) => {
        ready = resolve;
      });
      // The exact two mutations used by the API, paused before commit.
      const deactivation = prisma.$transaction(
        async (tx) => {
          await tx.geofence.update({
            where: { id: geofence.id, tenantId: tenantAId },
            data: { isActive: false },
          });
          await tx.geofenceDeviceState.deleteMany({
            where: { tenantId: tenantAId, geofenceId: geofence.id },
          });
          ready();
          await gate;
        },
        { timeout: 10000 },
      );
      await locked;
      let completed = false;
      const evaluation = app
        .get(GeofenceTransitionService)
        .evaluate(event.id, tenantAId)
        .finally(() => {
          completed = true;
        });
      try {
        const deadline = Date.now() + 4000;
        while (!completed) {
          const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND query LIKE '%WITH "evaluated" AS%'
                AND pid <> pg_backend_pid()
                AND cardinality(pg_blocking_pids(pid)) > 0
            ) AS blocked
          `;
          if (row.blocked) break;
          if (Date.now() > deadline)
            throw new Error('Evaluation never reached the lock barrier');
        }
      } finally {
        release();
        await deactivation;
      }
      expect(await evaluation).toEqual([]);
      expect(await stateRow(tenantAId, deviceId, geofence.id)).toBeNull();
      await request(server)
        .patch(`/api/v1/geofences/${geofence.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ isActive: true })
        .expect(200);
      const next = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: FAR,
        observedAt: at(1),
      });
      expect(transitionFor(next, geofence.id).transition).toBe(
        'BASELINE_OUTSIDE',
      );
    });

    it.each([1, 2, 3])(
      'creates one state row under alternating concurrency (round %s)',
      async () => {
        const geofence = await createGeofence({
          tenantId: tenantAId,
          name: 'Depot',
          ...AUSTIN,
          radiusMeters: 250,
        });
        const deviceId = await registerDevice(tokenA, 'device-1');

        const submissions = Array.from({ length: 8 }, (_unused, index) =>
          request(server)
            .post('/api/v1/location-events')
            .set('Authorization', `Bearer ${tokenA}`)
            .send({
              deviceKey: 'device-1',
              eventKey: `race-${index}`,
              observedAt: at(index).toISOString(),
              latitude: index % 2 === 0 ? AUSTIN.latitude : FAR.latitude,
              longitude: AUSTIN.longitude,
              accuracyMeters: 5,
            }),
        );

        const responses = await Promise.all(submissions);
        expect(responses.map((res) => res.status)).toEqual(
          new Array(8).fill(201) as number[],
        );

        const rows = await prisma.geofenceDeviceState.findMany({
          where: { tenantId: tenantAId, trackedDeviceId: deviceId },
        });
        expect(rows).toHaveLength(1);

        // Whatever the interleaving, the newest observation owns the state.
        const newest = responses
          .map((res) => res.body as EventBody)
          .reduce((latest, candidate) =>
            Date.parse(candidate.observedAt) > Date.parse(latest.observedAt)
              ? candidate
              : latest,
          );
        expect(rows[0].lastLocationEventId).toBe(newest.id);
        expect(rows[0].lastObservedAt.toISOString()).toBe(at(7).toISOString());
        expect(rows[0].state).toBe('OUTSIDE');
        expect(rows[0].geofenceId).toBe(geofence.id);
      },
    );

    it('resolves concurrent replays of one event to a single stored classification', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');

      const submit = () =>
        request(server)
          .post('/api/v1/location-events')
          .set('Authorization', `Bearer ${tokenA}`)
          .send({
            deviceKey: 'device-1',
            eventKey: 'evt-concurrent-replay',
            observedAt: at(0).toISOString(),
            latitude: AUSTIN.latitude,
            longitude: AUSTIN.longitude,
            accuracyMeters: 5,
          });

      const responses = await Promise.all([submit(), submit(), submit()]);

      expect(
        responses.every((res) => res.status === 201 || res.status === 200),
      ).toBe(true);

      const rows = await prisma.geofenceDeviceState.findMany({
        where: { tenantId: tenantAId, trackedDeviceId: deviceId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].lastTransition).toBe('BASELINE_INSIDE');
      expect(rows[0].geofenceId).toBe(geofence.id);

      // Every response describes the same single crossing.
      const classifications = responses.map(
        (res) => (res.body as EventBody).geofenceTransitions[0].transition,
      );
      expect(new Set(classifications)).toEqual(new Set(['BASELINE_INSIDE']));
    });

    it('advances nothing when the source event no longer exists', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');

      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
      });
      const before = await stateRow(tenantAId, deviceId, geofence.id);

      // A deleted source event evaluates no geofences.
      const orphan = await prisma.locationEvent.create({
        data: {
          tenantId: tenantAId,
          trackedDeviceId: deviceId,
          eventKey: 'evt-orphan',
          observedAt: at(9),
          latitude: FAR.latitude,
          longitude: FAR.longitude,
          accuracyMeters: 5,
        },
      });
      await prisma.$executeRaw`DELETE FROM "LocationEvent" WHERE "id" = ${orphan.id}`;

      const service = app.get(GeofenceTransitionService);

      // The event no longer exists, so nothing is evaluated and nothing is
      // written — a missing event is not an excuse to invent a transition.
      await expect(service.evaluate(orphan.id, tenantAId)).resolves.toEqual([]);

      const after = await stateRow(tenantAId, deviceId, geofence.id);
      expect(after?.lastLocationEventId).toBe(before?.lastLocationEventId);
      expect(after?.updatedAt.toISOString()).toBe(
        before?.updatedAt.toISOString(),
      );
    });

    it('reports a database failure through the established error envelope', async () => {
      await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');

      // Remove the state table for the duration of one request, then restore it.
      await prisma.$executeRaw`ALTER TABLE "GeofenceDeviceState" RENAME TO "GeofenceDeviceState_hidden"`;

      try {
        const res = await request(server)
          .post('/api/v1/location-events')
          .set('Authorization', `Bearer ${tokenA}`)
          .send({
            deviceKey: 'device-1',
            eventKey: 'evt-broken',
            observedAt: at(0).toISOString(),
            latitude: AUSTIN.latitude,
            longitude: AUSTIN.longitude,
            accuracyMeters: 5,
          })
          .expect(500);

        const body = res.body as ErrorBody;
        expect(body.message).toBe('Internal server error');
        expect(JSON.stringify(body)).not.toContain('GeofenceDeviceState');
        expect(JSON.stringify(body)).not.toContain('relation');
      } finally {
        await prisma.$executeRaw`ALTER TABLE "GeofenceDeviceState_hidden" RENAME TO "GeofenceDeviceState"`;
      }
      const saved = await prisma.locationEvent.findFirstOrThrow({
        where: { tenantId: tenantAId, eventKey: 'evt-broken' },
      });
      expect(await prisma.geofenceDeviceState.count()).toBe(0);
      const repaired = await ingest(tokenA, {
        deviceKey: 'device-1',
        eventKey: 'evt-broken',
        coordinates: AUSTIN,
        observedAt: at(0),
        expect: 200,
      });
      expect(repaired.id).toBe(saved.id);
      expect(repaired.replayed).toBe(true);
      expect(repaired.geofenceTransitions[0]).toMatchObject({
        transition: 'BASELINE_INSIDE',
        stateAdvanced: true,
      });
    });
  });

  describe('persistent state schema', () => {
    it('keys the state row on tenant, device and geofence', async () => {
      const [row] = await prisma.$queryRaw<Array<{ definition: string }>>`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conname = 'GeofenceDeviceState_pkey'
      `;

      // The identity IS the uniqueness constraint, which is also the conflict
      // target the atomic upsert infers.
      expect(row.definition).toBe(
        'PRIMARY KEY ("tenantId", "trackedDeviceId", "geofenceId")',
      );
    });

    it('binds every reference to the same tenant and cascades deletion', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ conname: string; definition: string }>
      >`
        SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = '"GeofenceDeviceState"'::regclass AND contype = 'f'
        ORDER BY conname
      `;

      expect(rows.map((row) => row.conname)).toEqual([
        'GeofenceDeviceState_geofenceId_tenantId_fkey',
        'GeofenceDeviceState_lastLocationEventId_tenantId_fkey',
        'GeofenceDeviceState_trackedDeviceId_tenantId_fkey',
      ]);

      for (const row of rows) {
        expect(row.definition).toContain('"tenantId")');
        expect(row.definition).toContain('ON DELETE CASCADE');
      }
    });

    it('stores the observation instant as an absolute instant', async () => {
      const [row] = await prisma.$queryRaw<Array<{ data_type: string }>>`
        SELECT data_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'GeofenceDeviceState'
          AND column_name = 'lastObservedAt'
      `;

      expect(row.data_type).toBe('timestamp with time zone');
    });

    it('has the lookup indexes retirement and state reads depend on', async () => {
      const rows = await prisma.$queryRaw<Array<{ index_name: string }>>`
        SELECT i.relname AS index_name
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class t ON t.oid = x.indrelid
        WHERE t.relname = 'GeofenceDeviceState'
        ORDER BY i.relname
      `;

      expect(rows.map((row) => row.index_name)).toEqual([
        'GeofenceDeviceState_pkey',
        'GeofenceDeviceState_tenantId_geofenceId_idx',
        'GeofenceDeviceState_tenantId_lastLocationEventId_idx',
      ]);
    });

    it.each(['geofence', 'trackedDevice', 'tenant', 'locationEvent'] as const)(
      'cascades %s deletion without deleting another tenant state',
      async (target) => {
        const disposableTenant = await prisma.tenant.create({
          data: { name: 'Cascade target' },
        });
        const geofence = await createGeofence({
          tenantId: disposableTenant.id,
          name: 'Depot',
          ...AUSTIN,
          radiusMeters: 250,
        });
        const device = await prisma.trackedDevice.create({
          data: {
            tenantId: disposableTenant.id,
            deviceKey: 'cascade',
            name: 'Cascade',
          },
        });
        const event = await prisma.locationEvent.create({
          data: {
            tenantId: disposableTenant.id,
            trackedDeviceId: device.id,
            eventKey: 'cascade',
            observedAt: at(0),
            ...AUSTIN,
            accuracyMeters: 5,
          },
        });
        await app
          .get(GeofenceTransitionService)
          .evaluate(event.id, disposableTenant.id);
        const other = await createGeofence({
          tenantId: tenantBId,
          name: 'Survivor',
          ...AUSTIN,
          radiusMeters: 250,
        });
        const otherDevice = await registerDevice(tokenB, 'cascade');
        await ingest(tokenB, {
          deviceKey: 'cascade',
          coordinates: AUSTIN,
          observedAt: at(0),
        });
        const survivor = await stateRow(tenantBId, otherDevice, other.id);
        expect(await prisma.geofenceDeviceState.count()).toBe(2);
        if (target === 'geofence')
          await prisma.geofence.delete({ where: { id: geofence.id } });
        if (target === 'trackedDevice')
          await prisma.trackedDevice.delete({ where: { id: device.id } });
        if (target === 'tenant')
          await prisma.tenant.delete({ where: { id: disposableTenant.id } });
        if (target === 'locationEvent')
          await prisma.locationEvent.delete({ where: { id: event.id } });
        expect(await prisma.geofenceDeviceState.count()).toBe(1);
        expect(await stateRow(tenantBId, otherDevice, other.id)).toEqual(
          survivor,
        );
        if (target !== 'tenant')
          await prisma.tenant.delete({ where: { id: disposableTenant.id } });
      },
    );
  });

  describe('phase boundary', () => {
    /**
     * GF-6 created no alert of any kind. GF-7 records exactly one durable alert
     * per accepted crossing and still creates no notification or delivery record
     * — the boundary moved by exactly one table column set, and no further.
     *
     * The alerting behaviour itself is proven in
     * test/integration/geofence-alert.integration-spec.ts. What is asserted here
     * is only that GF-6's own transition semantics did not acquire a second,
     * quieter side effect.
     */
    it('creates one alert for the crossing, and nothing that delivers it', async () => {
      await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');

      const baseline = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: FAR,
        observedAt: at(0),
      });

      // The baseline is not a crossing, so nothing is recorded for it.
      expect(await prisma.alertEvent.count()).toBe(0);
      expect(baseline.geofenceTransitions[0].alert).toBeUndefined();

      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(1),
      });

      const alerts = await prisma.alertEvent.findMany();
      expect(alerts).toHaveLength(1);
      expect(alerts[0].transition).toBe('ENTER');

      // Nothing about delivery exists on the row: no channel, recipient,
      // attempt count or sent-at value was invented for a phase that sends
      // nothing.
      expect(alerts[0].message).toBeNull();
      expect(alerts[0].eventType).toBeNull();
      expect(alerts[0].source).toBeNull();
    });

    it('adds no transition-history table beyond the current-state row', async () => {
      const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `;

      expect(tables.map((table) => table.table_name)).toEqual([
        'AlertEvent',
        'Geofence',
        'GeofenceDeviceState',
        'LocationEvent',
        'Membership',
        'Tenant',
        'TrackedDevice',
        'User',
        '_prisma_migrations',
        'spatial_ref_sys',
      ]);
    });
  });
});
