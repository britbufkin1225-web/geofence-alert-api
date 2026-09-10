import type { Server } from 'http';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { setupApp } from '../../src/app.setup';
import { GeofenceAlertQuery } from '../../src/location-events/geofence-alert.query';
import { GeofenceTransitionService } from '../../src/location-events/geofence-transition.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  createPrismaService,
  requireDisposableDatabaseUrl,
  truncateAll,
} from './support/database';

/**
 * REAL PostgreSQL/PostGIS proof for GF-7 deterministic alert-event creation and
 * deduplication, driven through the authenticated HTTP ingestion path against
 * the disposable database that `npm run test:db` provisions and migrates.
 *
 * This suite exercises application classification together with real database
 * constraints, locking and transaction behavior. Audit interleavings wrap the real
 * persistAndRead method to pause after insertion or force rollback; SQL is real.
 *
 * Concurrency is proven with controlled interleavings rather than a burst of
 * parallel requests. A burst exercises whichever schedule the operating system
 * happens to pick; the schedules that actually break deduplication are the ones
 * where a second writer arrives while the first is holding an uncommitted
 * conflicting row, and those are constructed here on purpose, with the blocked
 * writer confirmed through pg_blocking_pids before the first one commits.
 */

interface AuthResponse {
  accessToken: string;
  tenant: { id: string; name: string };
}

interface AlertBody {
  id: string;
  createdAt: string;
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
  alert?: AlertBody;
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

// Roughly 11 km north of AUSTIN: far outside a 250 m circle, so a geofence the
// device has left is still evaluated and can still report an EXIT.
const FAR = { latitude: 30.3672, longitude: -97.7431 };

const BASE_TIME = Date.parse('2026-09-09T06:00:00.000Z');

/** Distinct observation instants, minutes apart, in a fixed order. */
const at = (minutes: number) => new Date(BASE_TIME + minutes * 60_000);

describe('GF-7 geofence alert events (real PostgreSQL/PostGIS integration)', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;

  // A second, independent connection, so a controlled interleaving can hold an
  // uncommitted row while the application's own connection tries to write the
  // conflicting one.
  let competitor: PrismaService;

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
  }) =>
    prisma.geofence.create({
      data: {
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

  const alerts = () =>
    prisma.alertEvent.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  const alertCount = () => prisma.alertEvent.count();

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
   * Blocks until some other backend is waiting on a lock held by another
   * session, with its current statement matching `fragment`. This is how a
   * controlled interleaving proves the dangerous schedule was actually reached
   * rather than merely hoped for.
   */
  const waitUntilBlocked = async (fragment: string, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND query LIKE ${`%${fragment}%`}
            AND cardinality(pg_blocking_pids(pid)) > 0
        ) AS blocked
      `;
      if (row.blocked) return;
      if (Date.now() > deadline) {
        throw new Error(
          `No backend ever blocked on a statement like ${fragment}`,
        );
      }
    }
  };

  /** A resolvable gate, for pausing one side of an interleaving. */
  const gate = () => {
    let open!: () => void;
    const waited = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { open, waited };
  };

  /**
   * Establishes a device that is outside `geofenceId`, so the next observation
   * inside it is a genuine ENTER rather than a baseline.
   */
  const baselineOutside = async (token: string, deviceKey: string) =>
    ingest(token, {
      deviceKey,
      coordinates: FAR,
      observedAt: at(0),
    });

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

    competitor = createPrismaService();
    await competitor.$connect();

    await truncateAll(prisma);

    const a = await register('alert-a@example.com', 'Tenant A');
    const b = await register('alert-b@example.com', 'Tenant B');
    tokenA = a.accessToken;
    tokenB = b.accessToken;
    tenantAId = a.tenant.id;
    tenantBId = b.tenant.id;
  });

  afterAll(async () => {
    if (competitor) {
      await competitor.$disconnect();
    }
    if (app) {
      await truncateAll(prisma);
      await app.close();
    }
  });

  /**
   * Each test owns its geofences, devices, events and alerts. Truncating
   * identities too would invalidate the tokens issued once above, so only the
   * domain tables the alert path touches are cleared.
   */
  beforeEach(async () => {
    requireDisposableDatabaseUrl();
    await prisma.$executeRaw`TRUNCATE TABLE "AlertEvent", "GeofenceDeviceState", "LocationEvent", "TrackedDevice", "Geofence" RESTART IDENTITY CASCADE`;
  });

  describe('which transitions become alerts', () => {
    it('records exactly one alert for an ENTER, with database-owned provenance', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');
      await baselineOutside(tokenA, 'device-1');

      const body = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(1),
      });

      const transition = transitionFor(body, geofence.id);
      expect(transition.transition).toBe('ENTER');
      expect(transition.alert).toBeDefined();

      const stored = await alerts();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        id: transition.alert?.id,
        tenantId: tenantAId,
        trackedDeviceId: deviceId,
        geofenceId: geofence.id,
        sourceLocationEventId: body.id,
        transition: 'ENTER',
      });

      // The observation instant is the source's own, copied from the stored
      // event — not a server clock, and not a value the request could bend.
      expect(stored[0].observedAt.toISOString()).toBe(at(1).toISOString());
      expect(stored[0].createdAt.toISOString()).toBe(
        transition.alert?.createdAt,
      );

      // No coordinates, no distance, no message: nothing was copied that the
      // foreign keys do not already answer, and nothing was invented.
      expect(stored[0].latitude).toBeNull();
      expect(stored[0].longitude).toBeNull();
      expect(stored[0].message).toBeNull();
      expect(stored[0].eventType).toBeNull();
      expect(stored[0].source).toBeNull();
    });

    it('records exactly one alert for an EXIT', async () => {
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

      expect(transitionFor(body, geofence.id).transition).toBe('EXIT');
      const stored = await alerts();
      expect(stored).toHaveLength(1);
      expect(stored[0].transition).toBe('EXIT');
      expect(stored[0].sourceLocationEventId).toBe(body.id);
    });

    it.each([
      ['inside', AUSTIN, 'BASELINE_INSIDE'],
      ['outside', FAR, 'BASELINE_OUTSIDE'],
    ] as const)(
      'records nothing for a first observation %s the geofence',
      async (_label, coordinates, expected) => {
        const geofence = await createGeofence({
          tenantId: tenantAId,
          name: 'Depot',
          ...AUSTIN,
          radiusMeters: 250,
        });
        await registerDevice(tokenA, 'device-1');

        const body = await ingest(tokenA, {
          deviceKey: 'device-1',
          coordinates,
          observedAt: at(0),
        });

        // A device already inside a geofence never entered it while anyone was
        // watching. Reporting that as an ENTER would be inventing an event.
        const transition = transitionFor(body, geofence.id);
        expect(transition.transition).toBe(expected);
        expect(transition.stateAdvanced).toBe(true);
        expect(transition.alert).toBeUndefined();
        expect(await alertCount()).toBe(0);
      },
    );

    it.each([
      ['inside', AUSTIN, 'STAY_INSIDE'],
      ['outside', FAR, 'STAY_OUTSIDE'],
    ] as const)(
      'records nothing when the device stays %s',
      async (_label, coordinates, expected) => {
        const geofence = await createGeofence({
          tenantId: tenantAId,
          name: 'Depot',
          ...AUSTIN,
          radiusMeters: 250,
        });
        await registerDevice(tokenA, 'device-1');
        await ingest(tokenA, {
          deviceKey: 'device-1',
          coordinates,
          observedAt: at(0),
        });

        const body = await ingest(tokenA, {
          deviceKey: 'device-1',
          coordinates,
          observedAt: at(1),
        });

        const transition = transitionFor(body, geofence.id);
        expect(transition.transition).toBe(expected);
        expect(transition.alert).toBeUndefined();
        expect(await alertCount()).toBe(0);
      },
    );

    it('records nothing for an observation older than the stored state', async () => {
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
      const crossing = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(5),
      });

      // Arrives late, and is inside — but the boundary it would have to have
      // crossed belongs to an observation that has already happened.
      const late = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(2),
      });

      const transition = transitionFor(late, geofence.id);
      expect(transition.stateAdvanced).toBe(false);
      expect(transition.transition).toBe('STAY_INSIDE');
      expect(transition.alert).toBeUndefined();

      const stored = await alerts();
      expect(stored).toHaveLength(1);
      expect(stored[0].sourceLocationEventId).toBe(crossing.id);
    });

    it('records nothing when a geofence is deactivated and its state retired', async () => {
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

      // Retiring the state is not the device leaving the geofence. Nothing was
      // observed, so no EXIT is fabricated.
      expect(await stateRow(tenantAId, deviceId, geofence.id)).toBeNull();
      expect(await alertCount()).toBe(0);
    });

    it('records nothing for the new baseline after a reactivation', async () => {
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

      for (const isActive of [false, true]) {
        await request(server)
          .patch(`/api/v1/geofences/${geofence.id}`)
          .set('Authorization', `Bearer ${tokenA}`)
          .send({ isActive })
          .expect(200);
      }

      const body = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(1),
      });

      // Nothing is known about where the device was while the geofence was not
      // being evaluated, so this is a baseline, not an entry.
      const transition = transitionFor(body, geofence.id);
      expect(transition.transition).toBe('BASELINE_INSIDE');
      expect(transition.alert).toBeUndefined();
      expect(await alertCount()).toBe(0);
    });

    it('treats the exact boundary as inside, and alerts only on a real crossing onto it', async () => {
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

      const onBoundary = await prisma.locationEvent.create({
        data: {
          tenantId: tenantAId,
          trackedDeviceId: (
            await prisma.trackedDevice.findFirstOrThrow({
              where: { tenantId: tenantAId, deviceKey: 'device-1' },
            })
          ).id,
          eventKey: 'evt-boundary',
          observedAt: at(1),
          latitude: 30.2692,
          longitude: -97.7431,
          accuracyMeters: 5,
        },
      });

      // Pin the radius to the exact double PostGIS measures between the circle
      // centre and this stored observation, so it sits precisely on the
      // boundary rather than near it.
      await prisma.$executeRaw`
        UPDATE "Geofence"
        SET "radiusMeters" = (
          SELECT ST_Distance("Geofence"."centerPoint", "e"."observedPoint")
          FROM "LocationEvent" AS "e"
          WHERE "e"."id" = ${onBoundary.id}
        )
        WHERE "id" = ${geofence.id}
      `;

      const [transition] = await app
        .get(GeofenceTransitionService)
        .evaluate(onBoundary.id, tenantAId);

      // GF-5's boundary rule is `<=`, so the boundary belongs to INSIDE, and an
      // outside-to-boundary move is a genuine crossing.
      expect(transition.state).toBe('INSIDE');
      expect(transition.transition).toBe('ENTER');
      expect(transition.alert).toBeDefined();
      expect(await alertCount()).toBe(1);
    });
  });

  describe('deduplication and replay', () => {
    const crossOnce = async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');
      await baselineOutside(tokenA, 'device-1');
      const body = await ingest(tokenA, {
        deviceKey: 'device-1',
        eventKey: 'evt-crossing',
        coordinates: AUSTIN,
        observedAt: at(1),
      });
      return { geofence, body };
    };

    const replay = () =>
      ingest(tokenA, {
        deviceKey: 'device-1',
        eventKey: 'evt-crossing',
        coordinates: AUSTIN,
        observedAt: at(1),
        expect: 200,
      });

    it('returns the same alert identity when the source event is replayed', async () => {
      const { geofence, body } = await crossOnce();
      const first = transitionFor(body, geofence.id).alert;

      const replayed = await replay();
      const second = transitionFor(replayed, geofence.id);

      expect(replayed.replayed).toBe(true);
      expect(second.stateAdvanced).toBe(false);
      expect(second.transition).toBe('ENTER');
      expect(second.alert).toEqual(first);
      expect(await alertCount()).toBe(1);
    });

    it('leaves the immutable alert untouched across repeated replays', async () => {
      const { geofence, body } = await crossOnce();
      const before = (await alerts())[0];

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const replayed = await replay();
        expect(transitionFor(replayed, geofence.id).alert?.id).toBe(before.id);
      }

      const after = await alerts();
      expect(after).toHaveLength(1);
      // Byte-for-byte, including updatedAt: a replay writes nothing at all.
      expect(after[0]).toEqual(before);
      expect(body.id).toBe(after[0].sourceLocationEventId);
    });

    it('creates one row for sequential retries of the same submission', async () => {
      await crossOnce();
      await replay();
      await replay();

      expect(await alertCount()).toBe(1);
    });

    it('creates a distinct alert for each later real crossing', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');
      await baselineOutside(tokenA, 'device-1');

      const enter = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(1),
      });
      const exit = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: FAR,
        observedAt: at(2),
      });
      const reenter = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(3),
      });

      const stored = await alerts();
      expect(stored).toHaveLength(3);
      expect(
        stored.map((alert) => [alert.sourceLocationEventId, alert.transition]),
      ).toEqual([
        [enter.id, 'ENTER'],
        [exit.id, 'EXIT'],
        [reenter.id, 'ENTER'],
      ]);
      expect(new Set(stored.map((alert) => alert.id)).size).toBe(3);
      expect(transitionFor(reenter, geofence.id).alert?.id).not.toBe(
        transitionFor(enter, geofence.id).alert?.id,
      );
    });

    it('records one alert per geofence when one observation crosses two', async () => {
      const inner = await createGeofence({
        tenantId: tenantAId,
        name: 'Inner',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const outer = await createGeofence({
        tenantId: tenantAId,
        name: 'Outer',
        ...AUSTIN,
        radiusMeters: 1000,
      });
      await registerDevice(tokenA, 'device-1');
      await baselineOutside(tokenA, 'device-1');

      const body = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(1),
      });

      expect(transitionFor(body, inner.id).transition).toBe('ENTER');
      expect(transitionFor(body, outer.id).transition).toBe('ENTER');

      const stored = await alerts();
      expect(stored).toHaveLength(2);
      expect(stored.map((alert) => alert.geofenceId).sort()).toEqual(
        [inner.id, outer.id].sort(),
      );
      expect(new Set(stored.map((alert) => alert.id)).size).toBe(2);
    });

    it('answers with this observation own alert, never an earlier crossing of the same geofence', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');
      await baselineOutside(tokenA, 'device-1');

      // Enter, leave, enter again. Two ENTER alerts now exist for one device and
      // one geofence, differing only in which observation produced them.
      const firstEnter = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(1),
      });
      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: FAR,
        observedAt: at(2),
      });
      const secondEnter = await ingest(tokenA, {
        deviceKey: 'device-1',
        eventKey: 'evt-second-enter',
        coordinates: AUSTIN,
        observedAt: at(3),
      });

      const rowFor = async (sourceLocationEventId: string) =>
        prisma.alertEvent.findFirstOrThrow({
          where: { sourceLocationEventId },
        });

      expect(transitionFor(firstEnter, geofence.id).alert?.id).toBe(
        (await rowFor(firstEnter.id)).id,
      );
      expect(transitionFor(secondEnter, geofence.id).alert?.id).toBe(
        (await rowFor(secondEnter.id)).id,
      );

      // And the replay of the newer crossing still names its own alert, not the
      // older one that shares its device, geofence and direction.
      const replayed = await ingest(tokenA, {
        deviceKey: 'device-1',
        eventKey: 'evt-second-enter',
        coordinates: AUSTIN,
        observedAt: at(3),
        expect: 200,
      });

      expect(transitionFor(replayed, geofence.id).alert?.id).toBe(
        (await rowFor(secondEnter.id)).id,
      );
      expect(await alertCount()).toBe(3);
    });

    it('keeps two devices crossing one geofence distinct', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      for (const deviceKey of ['device-1', 'device-2']) {
        await registerDevice(tokenA, deviceKey);
        await ingest(tokenA, {
          deviceKey,
          coordinates: FAR,
          observedAt: at(0),
        });
        await ingest(tokenA, {
          deviceKey,
          coordinates: AUSTIN,
          observedAt: at(1),
        });
      }

      const stored = await alerts();
      expect(stored).toHaveLength(2);
      expect(new Set(stored.map((alert) => alert.trackedDeviceId)).size).toBe(
        2,
      );
      expect(stored.every((alert) => alert.geofenceId === geofence.id)).toBe(
        true,
      );
    });
  });

  describe('ordering and stale-event safety', () => {
    it('breaks an observedAt tie by event id and alerts only for the winner', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');
      await baselineOutside(tokenA, 'device-1');

      // Two observations sharing one instant, forced to a known id order.
      const lower = await prisma.locationEvent.create({
        data: {
          id: 'ctie-aaaaaaaaaaaaaaaaaaaaa',
          tenantId: tenantAId,
          trackedDeviceId: deviceId,
          eventKey: 'evt-tie-lower',
          observedAt: at(1),
          ...AUSTIN,
          accuracyMeters: 5,
        },
      });
      const higher = await prisma.locationEvent.create({
        data: {
          id: 'ctie-zzzzzzzzzzzzzzzzzzzzz',
          tenantId: tenantAId,
          trackedDeviceId: deviceId,
          eventKey: 'evt-tie-higher',
          observedAt: at(1),
          ...AUSTIN,
          accuracyMeters: 5,
        },
      });

      const service = app.get(GeofenceTransitionService);
      const [first] = await service.evaluate(higher.id, tenantAId);
      const [second] = await service.evaluate(lower.id, tenantAId);

      expect(first.transition).toBe('ENTER');
      expect(second.stateAdvanced).toBe(false);
      expect(second.transition).toBe('STAY_INSIDE');
      expect(second.alert).toBeUndefined();

      const stored = await alerts();
      expect(stored).toHaveLength(1);
      expect(stored[0].sourceLocationEventId).toBe(higher.id);
      expect(stored[0].geofenceId).toBe(geofence.id);
    });

    it('establishes a newest-first baseline and suppresses older observations as stale', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');

      // Newest first, oldest last. Only the first accepted observation advances
      // anything; every later one is stale.
      const newest = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(2),
      });
      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: FAR,
        observedAt: at(1),
      });
      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: FAR,
        observedAt: at(0),
      });

      // The newest observation baselined, and nothing older can rewrite history
      // into a crossing it never witnessed.
      const state = await stateRow(tenantAId, deviceId, geofence.id);
      expect(state?.lastLocationEventId).toBe(newest.id);
      expect(state?.lastTransition).toBe('BASELINE_INSIDE');
      expect(await alertCount()).toBe(0);
    });

    it('records a crossing for chronological arrival of the same positions', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');
      await baselineOutside(tokenA, 'device-1');
      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: FAR,
        observedAt: at(1),
      });
      const newest = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(2),
      });
      const state = await stateRow(tenantAId, deviceId, geofence.id);
      expect(state?.state).toBe('INSIDE');
      expect(state?.lastLocationEventId).toBe(newest.id);
      expect(state?.lastTransition).toBe('ENTER');
      expect(await alertCount()).toBe(1);
    });

    it('never points an alert at an event that is not the crossing it describes', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');
      await baselineOutside(tokenA, 'device-1');
      const enter = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(1),
      });
      const exit = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: FAR,
        observedAt: at(2),
      });

      const stored = await alerts();
      expect(stored).toHaveLength(2);

      for (const alert of stored) {
        const source = await prisma.locationEvent.findUniqueOrThrow({
          where: { id: alert.sourceLocationEventId },
        });
        expect(source.tenantId).toBe(alert.tenantId);
        expect(source.trackedDeviceId).toBe(alert.trackedDeviceId);
        expect(alert.observedAt.toISOString()).toBe(
          source.observedAt.toISOString(),
        );
      }

      const byEvent = new Map(
        stored.map((alert) => [alert.sourceLocationEventId, alert.transition]),
      );
      expect(byEvent.get(enter.id)).toBe('ENTER');
      expect(byEvent.get(exit.id)).toBe('EXIT');
      expect(stored.every((alert) => alert.trackedDeviceId === deviceId)).toBe(
        true,
      );
      expect(stored.every((alert) => alert.geofenceId === geofence.id)).toBe(
        true,
      );
    });
  });

  describe('controlled concurrency', () => {
    it.each(['same', 'newer', 'older', 'rollback'] as const)(
      'holds state and alert writes through transaction completion: %s contender',
      async (scenario) => {
        const geofence = await createGeofence({
          tenantId: tenantAId,
          name: 'Depot',
          ...AUSTIN,
          radiusMeters: 250,
        });
        const deviceId = await registerDevice(tokenA, 'device-1');
        await baselineOutside(tokenA, 'device-1');
        const before = await stateRow(tenantAId, deviceId, geofence.id);
        const firstEvent = await prisma.locationEvent.create({
          data: {
            tenantId: tenantAId,
            trackedDeviceId: deviceId,
            eventKey: 'held',
            accuracyMeters: 5,
            observedAt: at(2),
            ...AUSTIN,
          },
        });
        const secondEvent =
          scenario === 'same' || scenario === 'rollback'
            ? firstEvent
            : await prisma.locationEvent.create({
                data: {
                  tenantId: tenantAId,
                  trackedDeviceId: deviceId,
                  eventKey: 'contender',
                  accuracyMeters: 5,
                  observedAt: at(scenario === 'older' ? 1 : 3),
                  ...AUSTIN,
                },
              });
        const query = app.get(GeofenceAlertQuery);
        const original = query.persistAndRead.bind(query);
        const ready = gate();
        const release = gate();
        const spy = jest
          .spyOn(query, 'persistAndRead')
          .mockImplementationOnce(async (...args) => {
            const result = await original(...args);
            ready.open();
            await release.waited;
            if (scenario === 'rollback')
              throw new Error('audit rollback after alert insertion');
            return result;
          });
        const service = app.get(GeofenceTransitionService);
        const first = service.evaluate(firstEvent.id, tenantAId).then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        let second: ReturnType<typeof service.evaluate> | undefined;
        try {
          await ready.waited;
          expect(await stateRow(tenantAId, deviceId, geofence.id)).toEqual(
            before,
          );
          expect(await alertCount()).toBe(0);
          second = service.evaluate(secondEvent.id, tenantAId);
          await waitUntilBlocked('WITH "evaluated" AS');
        } finally {
          release.open();
          spy.mockRestore();
        }
        const left = await first;
        const right = await second;
        expect(Boolean(left.error)).toBe(scenario === 'rollback');
        const stored = await alerts();
        expect(stored).toHaveLength(1);
        expect(stored[0].sourceLocationEventId).toBe(firstEvent.id);
        const state = await stateRow(tenantAId, deviceId, geofence.id);
        expect(state?.lastLocationEventId).toBe(
          scenario === 'newer' ? secondEvent.id : firstEvent.id,
        );
        if (scenario === 'same' || scenario === 'rollback') {
          expect(right[0].alert?.id).toBe(stored[0].id);
          expect(right[0].stateAdvanced).toBe(scenario === 'rollback');
        } else {
          expect(right[0].alert).toBeUndefined();
          expect(right[0].stateAdvanced).toBe(scenario === 'newer');
        }
      },
    );

    /**
     * Sets up a device that has genuinely crossed into `geofence`, then deletes
     * the alert row. The crossing is still the authoritative stored state, so
     * replay can recreate the missing alert. This is an out-of-band deletion
     * fixture, not a transaction failure outcome.
     */
    const crossingWithMissingAlert = async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');
      await baselineOutside(tokenA, 'device-1');
      const crossing = await ingest(tokenA, {
        deviceKey: 'device-1',
        eventKey: 'evt-crossing',
        coordinates: AUSTIN,
        observedAt: at(1),
      });
      await prisma.alertEvent.deleteMany({});
      expect(await alertCount()).toBe(0);
      return { geofence, deviceId, crossing };
    };

    it('resolves two writers racing the same transition identity to one alert', async () => {
      const { geofence, crossing } = await crossingWithMissingAlert();
      const release = gate();

      // A third session pins the transition-state row, so both replays queue
      // behind it and are released into the same instant.
      const holder = competitor.$transaction(
        async (tx) => {
          await tx.$executeRaw`
            SELECT 1 FROM "GeofenceDeviceState"
            WHERE "tenantId" = ${tenantAId} AND "geofenceId" = ${geofence.id}
            FOR UPDATE
          `;
          await release.waited;
        },
        { timeout: 15000 },
      );

      const service = app.get(GeofenceTransitionService);
      const first = service.evaluate(crossing.id, tenantAId);
      const second = service.evaluate(crossing.id, tenantAId);

      await waitUntilBlocked('WITH "evaluated" AS');
      release.open();
      await holder;

      const [left, right] = await Promise.all([first, second]);

      const stored = await alerts();
      expect(stored).toHaveLength(1);
      expect(left[0].alert?.id).toBe(stored[0].id);
      expect(right[0].alert?.id).toBe(stored[0].id);
    });

    it('treats a uniqueness conflict as idempotent reuse rather than an error', async () => {
      const { geofence, deviceId, crossing } = await crossingWithMissingAlert();
      const release = gate();
      const preemptedId = 'cpreempted-alert-row-00001';

      // A competing session inserts the very row this ingestion is about to
      // insert, and holds it uncommitted. The application's insert must then
      // block on the index, and on release must find the row already there.
      const holder = competitor.$transaction(
        async (tx) => {
          await tx.$executeRaw`
            INSERT INTO "AlertEvent"
              ("id", "tenantId", "trackedDeviceId", "geofenceId",
               "sourceLocationEventId", "transition", "observedAt",
               "createdAt", "updatedAt")
            VALUES (${preemptedId}, ${tenantAId}, ${deviceId}, ${geofence.id},
                    ${crossing.id}, 'ENTER', ${at(1)}, NOW(), NOW())
          `;
          await release.waited;
        },
        { timeout: 15000 },
      );

      const replayed = request(server)
        .post('/api/v1/location-events')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          deviceKey: 'device-1',
          eventKey: 'evt-crossing',
          observedAt: at(1).toISOString(),
          ...AUSTIN,
          accuracyMeters: 5,
        });
      const settled = replayed.then((response) => response);

      await waitUntilBlocked('AlertEvent');
      release.open();
      await holder;

      const response = await settled;

      // The conflict is a successful outcome, not a 500 and not a leaked
      // constraint name.
      expect(response.status).toBe(200);
      const body = response.body as EventBody;
      expect(transitionFor(body, geofence.id).alert?.id).toBe(preemptedId);
      expect(JSON.stringify(body)).not.toContain('AlertEvent_crossing_key');

      const stored = await alerts();
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe(preemptedId);
    });

    it('cannot attach an alert to the stale side of a stale/newer interleaving', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');

      // Baseline inside, so an observation outside is a genuine EXIT.
      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(0),
      });

      const stale = await prisma.locationEvent.create({
        data: {
          tenantId: tenantAId,
          trackedDeviceId: deviceId,
          eventKey: 'evt-stale',
          observedAt: at(1),
          ...FAR,
          accuracyMeters: 5,
        },
      });
      const newer = await prisma.locationEvent.create({
        data: {
          tenantId: tenantAId,
          trackedDeviceId: deviceId,
          eventKey: 'evt-newer',
          observedAt: at(2),
          ...FAR,
          accuracyMeters: 5,
        },
      });

      const locked = gate();
      const release = gate();

      // The dangerous schedule, constructed deterministically: the stale
      // observation reaches the transition upsert while the state still says it
      // would be a crossing, and the state is advanced past it — and committed —
      // before the stale writer is allowed to proceed.
      const overtake = competitor.$transaction(
        async (tx) => {
          await tx.$executeRaw`
            SELECT 1 FROM "GeofenceDeviceState"
            WHERE "tenantId" = ${tenantAId} AND "geofenceId" = ${geofence.id}
            FOR UPDATE
          `;
          locked.open();
          await release.waited;
          await tx.$executeRaw`
            UPDATE "GeofenceDeviceState"
            SET "state" = 'OUTSIDE',
                "lastTransition" = 'EXIT',
                "lastLocationEventId" = ${newer.id},
                "lastObservedAt" = ${at(2)},
                "updatedAt" = NOW()
            WHERE "tenantId" = ${tenantAId} AND "geofenceId" = ${geofence.id}
          `;
        },
        { timeout: 15000 },
      );

      await locked.waited;
      const service = app.get(GeofenceTransitionService);
      const staleRun = service.evaluate(stale.id, tenantAId);

      await waitUntilBlocked('WITH "evaluated" AS');
      release.open();
      await overtake;

      const [staleResult] = await staleRun;

      // It was overtaken. It is outside the geofence, but it is not evidence
      // that the device left, and the state it would have to be compared
      // against belongs to a later observation.
      expect(staleResult.stateAdvanced).toBe(false);
      expect(staleResult.transition).toBe('STAY_OUTSIDE');
      expect(staleResult.alert).toBeUndefined();
      expect(await alertCount()).toBe(0);

      // The crossing that really was accepted still resolves to exactly one
      // alert, and it names the observation that owns the state.
      const [newerResult] = await service.evaluate(newer.id, tenantAId);
      expect(newerResult.transition).toBe('EXIT');

      const stored = await alerts();
      expect(stored).toHaveLength(1);
      expect(stored[0].sourceLocationEventId).toBe(newer.id);
      expect(stored[0].transition).toBe('EXIT');
      expect(stored[0].id).toBe(newerResult.alert?.id);

      // And the stale observation, replayed after the fact, still records
      // nothing.
      const [replayedStale] = await service.evaluate(stale.id, tenantAId);
      expect(replayedStale.alert).toBeUndefined();
      expect(await alertCount()).toBe(1);
    });

    it('creates no phantom alert when deactivation races an ingestion', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');
      await baselineOutside(tokenA, 'device-1');

      const crossing = await prisma.locationEvent.create({
        data: {
          tenantId: tenantAId,
          trackedDeviceId: deviceId,
          eventKey: 'evt-during-deactivation',
          observedAt: at(1),
          ...AUSTIN,
          accuracyMeters: 5,
        },
      });

      const release = gate();
      const ready = gate();

      // The exact two mutations the API performs on deactivation, paused before
      // commit.
      const deactivation = competitor.$transaction(
        async (tx) => {
          await tx.geofence.update({
            where: { id: geofence.id, tenantId: tenantAId },
            data: { isActive: false },
          });
          await tx.geofenceDeviceState.deleteMany({
            where: { tenantId: tenantAId, geofenceId: geofence.id },
          });
          ready.open();
          await release.waited;
        },
        { timeout: 15000 },
      );

      await ready.waited;
      const evaluation = app
        .get(GeofenceTransitionService)
        .evaluate(crossing.id, tenantAId);

      await waitUntilBlocked('WITH "evaluated" AS');
      release.open();
      await deactivation;

      // The geofence is gone from the evaluated set, so there is no comparison,
      // no state and no alert — and in particular no fabricated EXIT.
      expect(await evaluation).toEqual([]);
      expect(await stateRow(tenantAId, deviceId, geofence.id)).toBeNull();
      expect(await alertCount()).toBe(0);
    });
  });

  describe('transaction boundary and failure recovery', () => {
    it('commits no transition advancement when the alert insert fails, and converges on retry', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');
      await baselineOutside(tokenA, 'device-1');

      const before = await stateRow(tenantAId, deviceId, geofence.id);
      expect(before?.lastTransition).toBe('BASELINE_OUTSIDE');

      // Make every alert insert fail, without touching application code.
      await prisma.$executeRaw`ALTER TABLE "AlertEvent" ADD CONSTRAINT gf7_audit_failure CHECK ("transition" <> 'ENTER')`;

      try {
        const res = await request(server)
          .post('/api/v1/location-events')
          .set('Authorization', `Bearer ${tokenA}`)
          .send({
            deviceKey: 'device-1',
            eventKey: 'evt-crossing',
            observedAt: at(1).toISOString(),
            ...AUSTIN,
            accuracyMeters: 5,
          })
          .expect(500);

        const body = res.body as ErrorBody;
        expect(body.message).toBe('Internal server error');
        expect(JSON.stringify(body)).not.toContain('gf7_audit_failure');
        expect(JSON.stringify(body)).not.toContain('AlertEvent');

        // The crossing did not become durable, so the state that proves it is
        // still the one it was measured against. A committed ENTER with no
        // alert would be unrecoverable: nothing could re-derive it afterwards.
        expect(await stateRow(tenantAId, deviceId, geofence.id)).toEqual(
          before,
        );
        expect(await alertCount()).toBe(0);

        // The location event itself is stored, which is what makes the retry a
        // replay rather than a new observation.
        expect(
          await prisma.locationEvent.count({
            where: { tenantId: tenantAId, eventKey: 'evt-crossing' },
          }),
        ).toBe(1);
      } finally {
        await prisma.$executeRaw`ALTER TABLE "AlertEvent" DROP CONSTRAINT gf7_audit_failure`;
      }

      const repaired = await ingest(tokenA, {
        deviceKey: 'device-1',
        eventKey: 'evt-crossing',
        coordinates: AUSTIN,
        observedAt: at(1),
        expect: 200,
      });

      const transition = transitionFor(repaired, geofence.id);
      expect(transition.transition).toBe('ENTER');
      expect(transition.stateAdvanced).toBe(true);
      expect(transition.alert).toBeDefined();

      const stored = await alerts();
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe(transition.alert?.id);

      // And a further retry still converges on that one row.
      await ingest(tokenA, {
        deviceKey: 'device-1',
        eventKey: 'evt-crossing',
        coordinates: AUSTIN,
        observedAt: at(1),
        expect: 200,
      });
      expect(await alertCount()).toBe(1);
    });

    it('creates no alert when the transition query itself fails', async () => {
      await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');

      await prisma.$executeRaw`ALTER TABLE "GeofenceDeviceState" RENAME TO "GeofenceDeviceState_hidden"`;
      try {
        const res = await request(server)
          .post('/api/v1/location-events')
          .set('Authorization', `Bearer ${tokenA}`)
          .send({
            deviceKey: 'device-1',
            eventKey: 'evt-broken',
            observedAt: at(0).toISOString(),
            ...AUSTIN,
            accuracyMeters: 5,
          })
          .expect(500);

        expect((res.body as ErrorBody).message).toBe('Internal server error');
      } finally {
        await prisma.$executeRaw`ALTER TABLE "GeofenceDeviceState_hidden" RENAME TO "GeofenceDeviceState"`;
      }

      expect(await alertCount()).toBe(0);
    });

    const rejectedSubmissions: Array<
      [string, Record<string, unknown>, number, () => string]
    > = [
      [
        'an unvalidated body',
        { deviceKey: 'device-1', eventKey: 'evt-x' },
        400,
        () => `Bearer ${tokenA}`,
      ],
      [
        'a device the tenant does not own',
        {
          deviceKey: 'device-nobody-owns',
          eventKey: 'evt-x',
          observedAt: at(1).toISOString(),
          ...AUSTIN,
          accuracyMeters: 5,
        },
        404,
        () => `Bearer ${tokenA}`,
      ],
      [
        'an invalid bearer token',
        {
          deviceKey: 'device-1',
          eventKey: 'evt-x',
          observedAt: at(1).toISOString(),
          ...AUSTIN,
          accuracyMeters: 5,
        },
        401,
        () => 'Bearer not-a-real-token',
      ],
    ];

    it.each(rejectedSubmissions)(
      'creates no alert for %s',
      async (_label, body, status, auth) => {
        await createGeofence({
          tenantId: tenantAId,
          name: 'Depot',
          ...AUSTIN,
          radiusMeters: 250,
        });
        await registerDevice(tokenA, 'device-1');
        await baselineOutside(tokenA, 'device-1');

        await request(server)
          .post('/api/v1/location-events')
          .set('Authorization', auth())
          .send(body)
          .expect(status);

        expect(await alertCount()).toBe(0);
      },
    );

    it('creates no alert when an event key is reused for a different observation', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');
      await ingest(tokenA, {
        deviceKey: 'device-1',
        eventKey: 'evt-reused',
        coordinates: FAR,
        observedAt: at(0),
      });

      // Same key, different observation: a 409, and transition detection is
      // never reached, so no crossing and no alert can be manufactured from it.
      await ingest(tokenA, {
        deviceKey: 'device-1',
        eventKey: 'evt-reused',
        coordinates: AUSTIN,
        observedAt: at(0),
        expect: 409,
      });

      expect(await alertCount()).toBe(0);
      expect(
        await stateRow(
          tenantAId,
          (
            await prisma.trackedDevice.findFirstOrThrow({
              where: { tenantId: tenantAId, deviceKey: 'device-1' },
            })
          ).id,
          geofence.id,
        ),
      ).toMatchObject({
        lastTransition: 'BASELINE_OUTSIDE',
      });
    });
  });

  describe('tenant isolation', () => {
    /** The same device key and coincident geofences, in both tenants. */
    const twoTenantsCrossing = async () => {
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
      const deviceA = await registerDevice(tokenA, 'shared-key');
      const deviceB = await registerDevice(tokenB, 'shared-key');

      const crossings = [];
      for (const token of [tokenA, tokenB]) {
        await ingest(token, {
          deviceKey: 'shared-key',
          coordinates: FAR,
          observedAt: at(0),
        });
        crossings.push(
          await ingest(token, {
            deviceKey: 'shared-key',
            coordinates: AUSTIN,
            observedAt: at(1),
          }),
        );
      }

      return { geofenceA, geofenceB, deviceA, deviceB, crossings };
    };

    it('keeps coincident geofences and shared device keys in separate tenants distinct', async () => {
      const { geofenceA, geofenceB, deviceA, deviceB } =
        await twoTenantsCrossing();

      const stored = await alerts();
      expect(stored).toHaveLength(2);

      const forA = stored.find((alert) => alert.tenantId === tenantAId);
      const forB = stored.find((alert) => alert.tenantId === tenantBId);

      expect(forA?.geofenceId).toBe(geofenceA.id);
      expect(forA?.trackedDeviceId).toBe(deviceA);
      expect(forB?.geofenceId).toBe(geofenceB.id);
      expect(forB?.trackedDeviceId).toBe(deviceB);

      // The external key is identical in both tenants; the deduplication key is
      // not, because it is built from internal, tenant-scoped identities.
      expect(forA?.id).not.toBe(forB?.id);
    });

    it('never lets one tenant see or reuse another tenant alert through ingestion', async () => {
      const { geofenceA, crossings } = await twoTenantsCrossing();

      // Tenant B replays its own key with tenant A's geofence in play. Its
      // response can only ever describe its own geofence.
      const replayed = await ingest(tokenB, {
        deviceKey: 'shared-key',
        eventKey: crossings[1].eventKey,
        coordinates: AUSTIN,
        observedAt: at(1),
        expect: 200,
      });

      expect(
        replayed.geofenceTransitions.some(
          (entry) => entry.geofenceId === geofenceA.id,
        ),
      ).toBe(false);

      const alertIdsA = (
        await prisma.alertEvent.findMany({ where: { tenantId: tenantAId } })
      ).map((alert) => alert.id);
      expect(
        replayed.geofenceTransitions.every(
          (entry) => !entry.alert || !alertIdsA.includes(entry.alert.id),
        ),
      ).toBe(true);
    });

    it('rejects a cross-tenant alert at the database layer', async () => {
      const { geofenceA, deviceB, crossings } = await twoTenantsCrossing();

      // Tenant B's device, tenant A's geofence. Every combination that mixes
      // tenants is refused by a composite foreign key, not by a service check.
      await expect(
        prisma.$executeRaw`
          INSERT INTO "AlertEvent"
            ("id", "tenantId", "trackedDeviceId", "geofenceId",
             "sourceLocationEventId", "transition", "observedAt",
             "createdAt", "updatedAt")
          VALUES ('cross-tenant-alert', ${tenantBId}, ${deviceB}, ${geofenceA.id},
                  ${crossings[1].id}, 'ENTER', NOW(), NOW(), NOW())
        `,
      ).rejects.toThrow(/AlertEvent_geofenceId_tenantId_fkey/);

      await expect(
        prisma.$executeRaw`
          INSERT INTO "AlertEvent"
            ("id", "tenantId", "trackedDeviceId", "geofenceId",
             "sourceLocationEventId", "transition", "observedAt",
             "createdAt", "updatedAt")
          VALUES ('cross-tenant-alert', ${tenantAId}, ${deviceB}, ${geofenceA.id},
                  ${crossings[1].id}, 'ENTER', NOW(), NOW(), NOW())
        `,
      ).rejects.toThrow(/AlertEvent_trackedDeviceId_tenantId_fkey/);
    });

    it('refuses a source event belonging to another tenant', async () => {
      const { geofenceB, deviceB, crossings } = await twoTenantsCrossing();

      await expect(
        prisma.$executeRaw`
          INSERT INTO "AlertEvent"
            ("id", "tenantId", "trackedDeviceId", "geofenceId",
             "sourceLocationEventId", "transition", "observedAt",
             "createdAt", "updatedAt")
          VALUES ('foreign-source-alert', ${tenantBId}, ${deviceB}, ${geofenceB.id},
                  ${crossings[0].id}, 'ENTER', NOW(), NOW(), NOW())
        `,
      ).rejects.toThrow(/AlertEvent_sourceLocationEventId_tenantId_fkey/);
    });

    it('ignores a tenant identifier supplied by the caller', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');
      await baselineOutside(tokenA, 'device-1');

      // The global validation pipe rejects unknown properties outright, so a
      // spoofed tenant never reaches the service at all.
      await request(server)
        .post('/api/v1/location-events')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          deviceKey: 'device-1',
          eventKey: 'evt-spoof',
          observedAt: at(1).toISOString(),
          ...AUSTIN,
          accuracyMeters: 5,
          tenantId: tenantBId,
        })
        .expect(400);

      expect(await alertCount()).toBe(0);

      const accepted = await ingest(tokenA, {
        deviceKey: 'device-1',
        eventKey: 'evt-spoof',
        coordinates: AUSTIN,
        observedAt: at(1),
      });

      expect(transitionFor(accepted, geofence.id).transition).toBe('ENTER');
      const stored = await alerts();
      expect(stored).toHaveLength(1);
      expect(stored[0].tenantId).toBe(tenantAId);
    });

    it.each(['geofence', 'trackedDevice', 'locationEvent', 'tenant'] as const)(
      'cascades %s deletion without touching another tenant alert',
      async (target) => {
        // A throwaway tenant, so deleting it cannot invalidate the tokens the
        // rest of this suite was issued once.
        const disposable = await prisma.tenant.create({
          data: { name: 'Cascade target' },
        });
        const geofence = await createGeofence({
          tenantId: disposable.id,
          name: 'Depot',
          ...AUSTIN,
          radiusMeters: 250,
        });
        const device = await prisma.trackedDevice.create({
          data: {
            tenantId: disposable.id,
            deviceKey: 'cascade',
            name: 'Cascade',
          },
        });

        const service = app.get(GeofenceTransitionService);
        for (const [minutes, coordinates] of [
          [0, FAR],
          [1, AUSTIN],
        ] as const) {
          const event = await prisma.locationEvent.create({
            data: {
              tenantId: disposable.id,
              trackedDeviceId: device.id,
              eventKey: `cascade-${minutes}`,
              observedAt: at(minutes),
              ...coordinates,
              accuracyMeters: 5,
            },
          });
          await service.evaluate(event.id, disposable.id);
        }

        const crossing = await prisma.alertEvent.findFirstOrThrow({
          where: { tenantId: disposable.id },
        });

        // A second tenant crosses its own coincident geofence with the same
        // external device key. Its alert must survive every deletion below.
        await createGeofence({
          tenantId: tenantBId,
          name: 'Depot',
          ...AUSTIN,
          radiusMeters: 250,
        });
        await registerDevice(tokenB, 'cascade');
        await ingest(tokenB, {
          deviceKey: 'cascade',
          coordinates: FAR,
          observedAt: at(0),
        });
        await ingest(tokenB, {
          deviceKey: 'cascade',
          coordinates: AUSTIN,
          observedAt: at(1),
        });
        const survivor = await prisma.alertEvent.findFirstOrThrow({
          where: { tenantId: tenantBId },
        });

        expect(await alertCount()).toBe(2);

        if (target === 'geofence') {
          await prisma.geofence.delete({ where: { id: geofence.id } });
        }
        if (target === 'trackedDevice') {
          await prisma.trackedDevice.delete({ where: { id: device.id } });
        }
        if (target === 'locationEvent') {
          await prisma.locationEvent.delete({
            where: { id: crossing.sourceLocationEventId },
          });
        }
        if (target === 'tenant') {
          await prisma.tenant.delete({ where: { id: disposable.id } });
        }

        const remaining = await alerts();
        expect(remaining).toHaveLength(1);
        expect(remaining[0]).toEqual(survivor);

        if (target !== 'tenant') {
          await prisma.tenant.delete({ where: { id: disposable.id } });
        }
      },
    );
  });

  describe('persistent alert schema', () => {
    it('does not mistake tenant-consistent SQL provenance for proof of a crossing', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');
      const otherDevice = await registerDevice(tokenA, 'device-2');
      const baseline = await baselineOutside(tokenA, 'device-1');
      const fabricated = await prisma.alertEvent.create({
        data: {
          tenantId: tenantAId,
          geofenceId: geofence.id,
          trackedDeviceId: otherDevice,
          sourceLocationEventId: baseline.id,
          transition: 'ENTER',
          observedAt: at(9),
        },
      });
      expect(fabricated.trackedDeviceId).not.toBe(baseline.trackedDeviceId);
      expect(fabricated.observedAt.toISOString()).not.toBe(baseline.observedAt);
      expect(baseline.geofenceTransitions[0].transition).toBe(
        'BASELINE_OUTSIDE',
      );
    });

    it('rolls back a legitimate crossing on an unrelated uniqueness collision', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      const deviceId = await registerDevice(tokenA, 'device-1');
      await baselineOutside(tokenA, 'device-1');
      await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(1),
      });
      const before = await stateRow(tenantAId, deviceId, geofence.id);
      await prisma.$executeRaw`CREATE UNIQUE INDEX gf7_audit_collision ON "AlertEvent" ("geofenceId")`;
      try {
        await ingest(tokenA, {
          deviceKey: 'device-1',
          eventKey: 'exit-collision',
          coordinates: FAR,
          observedAt: at(2),
          expect: 500,
        });
        expect(await stateRow(tenantAId, deviceId, geofence.id)).toEqual(
          before,
        );
        expect(await alertCount()).toBe(1);
      } finally {
        await prisma.$executeRaw`DROP INDEX gf7_audit_collision`;
      }
      await ingest(tokenA, {
        deviceKey: 'device-1',
        eventKey: 'exit-collision',
        coordinates: FAR,
        observedAt: at(2),
        expect: 200,
      });
      expect(await alertCount()).toBe(2);
    });

    it('deduplicates on the exact crossing identity, in the intended column order', async () => {
      const [row] = await prisma.$queryRaw<Array<{ definition: string }>>`
        SELECT pg_get_indexdef(i.indexrelid) AS definition
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'AlertEvent_crossing_key' AND i.indisunique
      `;

      // Column order is asserted, not just membership: the leading
      // (tenantId, trackedDeviceId) prefix is what makes tenant- and
      // device-scoped reads free, and what a reordered key would silently lose.
      expect(row.definition).toBe(
        'CREATE UNIQUE INDEX "AlertEvent_crossing_key" ON public."AlertEvent" ' +
          'USING btree ("tenantId", "trackedDeviceId", "geofenceId", "sourceLocationEventId", transition)',
      );
    });

    it('binds every reference to the same tenant and cascades deletion', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ conname: string; definition: string }>
      >`
        SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = '"AlertEvent"'::regclass AND contype = 'f'
        ORDER BY conname
      `;

      expect(rows.map((row) => row.conname)).toEqual([
        'AlertEvent_geofenceId_tenantId_fkey',
        'AlertEvent_sourceLocationEventId_tenantId_fkey',
        'AlertEvent_trackedDeviceId_tenantId_fkey',
      ]);

      for (const row of rows) {
        expect(row.definition).toContain('"tenantId")');
        expect(row.definition).toContain('ON DELETE CASCADE');
        expect(row.definition).toContain('ON UPDATE CASCADE');
      }

      // The GF-1 single-column key is gone, replaced by the composite one.
      expect(rows.map((row) => row.conname)).not.toContain(
        'AlertEvent_geofenceId_fkey',
      );
    });

    it('restricts stored transition labels to ENTER and EXIT', async () => {
      const [row] = await prisma.$queryRaw<Array<{ definition: string }>>`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conname = 'AlertEvent_transition_crossing_check'
      `;

      expect(row.definition).toContain('ENTER');
      expect(row.definition).toContain('EXIT');
      expect(row.definition).not.toContain('BASELINE');
      expect(row.definition).not.toContain('STAY');
    });

    it.each([
      ['BASELINE_INSIDE'],
      ['BASELINE_OUTSIDE'],
      ['STAY_INSIDE'],
      ['STAY_OUTSIDE'],
    ])(
      'rejects a direct %s insert, bypassing the service entirely',
      async (transition) => {
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

        await expect(
          prisma.$executeRaw`
          INSERT INTO "AlertEvent"
            ("id", "tenantId", "trackedDeviceId", "geofenceId",
             "sourceLocationEventId", "transition", "observedAt",
             "createdAt", "updatedAt")
          VALUES ('not-a-crossing', ${tenantAId}, ${deviceId}, ${geofence.id},
                  ${event.id}, ${transition}::"GeofenceTransition", NOW(), NOW(), NOW())
        `,
        ).rejects.toThrow(/AlertEvent_transition_crossing_check/);
      },
    );

    it('stores the observation instant as an absolute instant', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ column_name: string; data_type: string }>
      >`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'AlertEvent'
          AND column_name IN ('observedAt', 'createdAt', 'updatedAt')
        ORDER BY column_name
      `;

      expect(rows).toEqual([
        // Server bookkeeping keeps the plain type every other model uses.
        { column_name: 'createdAt', data_type: 'timestamp without time zone' },
        // The source's own instant keeps the timestamptz the observation was
        // stored with, so no offset is lost between LocationEvent and here.
        { column_name: 'observedAt', data_type: 'timestamp with time zone' },
        { column_name: 'updatedAt', data_type: 'timestamp without time zone' },
      ]);
    });

    it('has the lookup indexes the alert path depends on, and no more', async () => {
      const rows = await prisma.$queryRaw<Array<{ index_name: string }>>`
        SELECT i.relname AS index_name
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class t ON t.oid = x.indrelid
        WHERE t.relname = 'AlertEvent'
        ORDER BY i.relname
      `;

      expect(rows.map((row) => row.index_name)).toEqual([
        'AlertEvent_crossing_key',
        'AlertEvent_pkey',
        'AlertEvent_tenantId_geofenceId_idx',
        // GF-8 added the ordering index the tenant-scoped alert list reads
        // through. It is listed here because this assertion is deliberately
        // exhaustive — "and no more" is the point of it, and an index nobody
        // declared appearing on this table should still fail. The three GF-7
        // indexes above are unchanged, and GF-8 dropped and replaced nothing.
        'AlertEvent_tenantId_observedAt_id_idx',
        'AlertEvent_tenantId_sourceLocationEventId_idx',
      ]);
    });

    it('requires every provenance column and leaves the legacy ones optional', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ column_name: string; is_nullable: string }>
      >`
        SELECT column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'AlertEvent'
        ORDER BY column_name
      `;

      const nullable = new Map(
        rows.map((row) => [row.column_name, row.is_nullable === 'YES']),
      );

      for (const column of [
        'tenantId',
        'trackedDeviceId',
        'geofenceId',
        'sourceLocationEventId',
        'transition',
        'observedAt',
      ]) {
        expect(nullable.get(column)).toBe(false);
      }

      // Left to the phase that implements alert delivery and management, and
      // deliberately never written with an invented value in the meantime.
      for (const column of ['eventType', 'message', 'source']) {
        expect(nullable.get(column)).toBe(true);
      }
    });
  });

  describe('phase boundary', () => {
    it('adds no delivery, queue, outbox or notification table', async () => {
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

    it('adds no delivery column to the alert itself', async () => {
      const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'AlertEvent'
        ORDER BY column_name
      `;

      const columns = rows.map((row) => row.column_name);

      // The set is pinned so that a delivery, retry, dwell or acknowledgement
      // column cannot be added without this failing.
      expect(columns).toEqual([
        'createdAt',
        'eventType',
        'geofenceId',
        'id',
        'latitude',
        'longitude',
        'message',
        'observedAt',
        'severity',
        'source',
        'sourceLocationEventId',
        'status',
        'tenantId',
        'trackedDeviceId',
        'transition',
        'updatedAt',
      ]);
    });

    it('leaves the GF-5 evaluation endpoint read-only', async () => {
      const geofence = await createGeofence({
        tenantId: tenantAId,
        name: 'Depot',
        ...AUSTIN,
        radiusMeters: 250,
      });
      await registerDevice(tokenA, 'device-1');
      await baselineOutside(tokenA, 'device-1');
      const event = await ingest(tokenA, {
        deviceKey: 'device-1',
        coordinates: AUSTIN,
        observedAt: at(1),
      });

      const before = await alerts();
      expect(before).toHaveLength(1);

      const res = await request(server)
        .get(`/api/v1/location-events/${event.id}/geofence-evaluation`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(JSON.stringify(res.body)).toContain(geofence.id);
      // Evaluating an already-crossed event creates nothing and changes nothing.
      expect(await alerts()).toEqual(before);
    });
  });
});
