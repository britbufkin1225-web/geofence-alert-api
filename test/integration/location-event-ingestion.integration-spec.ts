import type { Server } from 'http';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { setupApp } from '../../src/app.setup';
import { PrismaService } from '../../src/prisma/prisma.service';
import { requireDisposableDatabaseUrl, truncateAll } from './support/database';

/**
 * REAL database integration test for GF-4 ingestion (not a Prisma mock). It
 * drives the HTTP API end-to-end against the disposable PostgreSQL/PostGIS
 * database that `npm run test:db` provisions and migrates.
 *
 * The properties proven here cannot be proven against a mock: that tenant
 * ownership survives a genuine round trip, that the idempotency key is enforced
 * by a database constraint under real concurrency, that scalar coordinates and
 * the generated geography point agree in storage, and that a device key
 * belonging to another tenant is indistinguishable from one that exists nowhere.
 */

interface AuthResponse {
  accessToken: string;
  tenant: { id: string; name: string };
}

interface EventBody {
  id: string;
  tenantId: string;
  trackedDeviceId: string;
  deviceKey: string;
  eventKey: string;
  observedAt: string;
  receivedAt: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  replayed: boolean;
}

const OBSERVED_AT = '2026-09-09T06:00:00.000Z';

const validEvent = (overrides: Record<string, unknown> = {}) => ({
  deviceKey: 'device-a1',
  eventKey: 'evt-0001',
  observedAt: OBSERVED_AT,
  latitude: 30.2672,
  longitude: -97.7431,
  accuracyMeters: 8.5,
  ...overrides,
});

describe('Location event ingestion (real PostgreSQL/PostGIS integration)', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;

  let tokenA: string;
  let tokenB: string;
  let tenantAId: string;
  let tenantBId: string;
  let deviceAId: string;
  let inactiveDeviceKey: string;

  const auth = (token: string) => `Bearer ${token}`;

  const register = async (email: string, tenantName: string) => {
    const res = await request(server)
      .post('/api/v1/auth/register')
      .send({ email, password: 'password-Aa1', tenantName })
      .expect(201);
    return res.body as AuthResponse;
  };

  const registerDevice = async (
    token: string,
    deviceKey: string,
    name: string,
  ) => {
    const res = await request(server)
      .post('/api/v1/tracked-devices')
      .set('Authorization', auth(token))
      .send({ deviceKey, name })
      .expect(201);
    return res.body as { id: string; tenantId: string; deviceKey: string };
  };

  const ingest = (token: string, body: unknown) =>
    request(server)
      .post('/api/v1/location-events')
      .set('Authorization', auth(token))
      .send(body as object);

  const countEvents = (where: Record<string, unknown> = {}) =>
    prisma.locationEvent.count({ where });

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

    const a = await register('device-owner-a@example.com', 'Tenant A');
    const b = await register('device-owner-b@example.com', 'Tenant B');
    tokenA = a.accessToken;
    tokenB = b.accessToken;
    tenantAId = a.tenant.id;
    tenantBId = b.tenant.id;

    deviceAId = (await registerDevice(tokenA, 'device-a1', 'Van A1')).id;
    // Same external key in the other tenant: legitimate, and must not collide.
    await registerDevice(tokenB, 'device-a1', 'Van B1');

    const inactive = await registerDevice(tokenA, 'device-a2', 'Van A2');
    inactiveDeviceKey = inactive.deviceKey;
    await prisma.trackedDevice.update({
      where: { id: inactive.id },
      data: { isActive: false },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await truncateAll(prisma);
    }
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    await prisma.locationEvent.deleteMany({});
  });

  describe('device registration ownership', () => {
    it('gives A and B independent tenants', () => {
      expect(tenantAId).not.toEqual(tenantBId);
    });

    it('lets two tenants own the same external device key', async () => {
      const devices = await prisma.trackedDevice.findMany({
        where: { deviceKey: 'device-a1' },
        select: { tenantId: true },
        orderBy: { tenantId: 'asc' },
      });

      expect(devices).toHaveLength(2);
      expect(new Set(devices.map((d) => d.tenantId))).toEqual(
        new Set([tenantAId, tenantBId]),
      );
    });

    it('rejects a duplicate device key inside one tenant with 409', async () => {
      await request(server)
        .post('/api/v1/tracked-devices')
        .set('Authorization', auth(tokenA))
        .send({ deviceKey: 'device-a1', name: 'Duplicate' })
        .expect(409);
    });
  });

  describe('authenticated ingestion', () => {
    it('rejects an anonymous submission with 401 and stores nothing', async () => {
      await request(server)
        .post('/api/v1/location-events')
        .send(validEvent())
        .expect(401);

      expect(await countEvents()).toBe(0);
    });

    it('stores one event with the server-derived tenant', async () => {
      const res = await ingest(tokenA, validEvent()).expect(201);
      const body = res.body as EventBody;

      expect(body.tenantId).toBe(tenantAId);
      expect(body.trackedDeviceId).toBe(deviceAId);
      expect(body.deviceKey).toBe('device-a1');
      expect(body.replayed).toBe(false);
      expect(await countEvents()).toBe(1);

      const stored = await prisma.locationEvent.findUniqueOrThrow({
        where: { id: body.id },
      });
      expect(stored.tenantId).toBe(tenantAId);
      expect(stored.trackedDeviceId).toBe(deviceAId);
      expect(stored.latitude).toBe(30.2672);
      expect(stored.longitude).toBe(-97.7431);
      expect(stored.accuracyMeters).toBe(8.5);
    });

    it('preserves the exact observed instant and records a receipt time', async () => {
      const before = Date.now();
      const res = await ingest(tokenA, validEvent()).expect(201);
      const after = Date.now();
      const body = res.body as EventBody;

      expect(body.observedAt).toBe(OBSERVED_AT);

      const stored = await prisma.locationEvent.findUniqueOrThrow({
        where: { id: body.id },
      });
      expect(stored.observedAt.toISOString()).toBe(OBSERVED_AT);
      // The receipt time is assigned by the server, not the client, and lands
      // inside the request window rather than at the observation time.
      expect(stored.receivedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(stored.receivedAt.getTime()).toBeLessThanOrEqual(after + 1000);
      expect(stored.receivedAt.getTime()).not.toBe(stored.observedAt.getTime());
    });

    it('normalizes an offset timestamp to the same stored instant', async () => {
      const res = await ingest(
        tokenA,
        validEvent({ observedAt: '2026-09-09T08:00:00.000+02:00' }),
      ).expect(201);

      const stored = await prisma.locationEvent.findUniqueOrThrow({
        where: { id: (res.body as EventBody).id },
      });
      expect(stored.observedAt.toISOString()).toBe(OBSERVED_AT);
    });

    it.each([
      ['minimum latitude', { latitude: -90 }],
      ['maximum latitude', { latitude: 90 }],
      ['minimum longitude', { longitude: -180 }],
      ['maximum longitude', { longitude: 180 }],
      ['null island', { latitude: 0, longitude: 0 }],
      ['zero accuracy', { accuracyMeters: 0 }],
      ['maximum accuracy', { accuracyMeters: 100000 }],
    ])('persists the %s boundary', async (_label, override) => {
      const key = `evt-boundary-${Math.random().toString(36).slice(2, 10)}`;
      const res = await ingest(
        tokenA,
        validEvent({ ...override, eventKey: key }),
      ).expect(201);

      const stored = await prisma.locationEvent.findUniqueOrThrow({
        where: { id: (res.body as EventBody).id },
      });
      for (const [field, value] of Object.entries(override)) {
        expect(stored[field as 'latitude']).toBe(value);
      }
    });
  });

  describe('scalar / spatial synchronization', () => {
    const readPoint = (id: string) =>
      prisma.$queryRaw<
        Array<{ x: number; y: number; srid: number; geometry_type: string }>
      >`
        SELECT ST_X("observedPoint"::geometry) AS x,
               ST_Y("observedPoint"::geometry) AS y,
               ST_SRID("observedPoint"::geometry) AS srid,
               GeometryType("observedPoint"::geometry) AS geometry_type
        FROM "LocationEvent"
        WHERE "id" = ${id}
      `;

    it('derives a Point with longitude as X and latitude as Y', async () => {
      const res = await ingest(tokenA, validEvent()).expect(201);
      const [point] = await readPoint((res.body as EventBody).id);

      expect(point.geometry_type).toBe('POINT');
      expect(point.srid).toBe(4326);
      // Sign and magnitude differ, so a swapped axis order cannot still pass.
      expect(point.x).toBeCloseTo(-97.7431, 9);
      expect(point.y).toBeCloseTo(30.2672, 9);
    });

    it('refuses a direct write to the generated point', async () => {
      const res = await ingest(tokenA, validEvent()).expect(201);
      const id = (res.body as EventBody).id;

      await expect(
        prisma.$executeRaw`
          UPDATE "LocationEvent"
          SET "observedPoint" = ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography
          WHERE "id" = ${id}
        `,
      ).rejects.toThrow(/can only be updated to DEFAULT/i);

      const [point] = await readPoint(id);
      expect(point.x).toBeCloseTo(-97.7431, 9);
    });
  });

  describe('tenant isolation', () => {
    it("A cannot ingest for B's device, and B's tenant gains nothing", async () => {
      // 'device-b-only' exists only in tenant B.
      await registerDevice(tokenB, 'device-b-only', 'B Only');

      const res = await ingest(
        tokenA,
        validEvent({ deviceKey: 'device-b-only' }),
      ).expect(404);

      expect((res.body as { message: string }).message).toBe(
        'Tracked device not found',
      );
      expect(JSON.stringify(res.body)).not.toContain(tenantBId);
      expect(await countEvents({ tenantId: tenantBId })).toBe(0);
    });

    it('returns the identical 404 for a key that exists nowhere', async () => {
      const foreign = await ingest(
        tokenA,
        validEvent({ deviceKey: 'device-b-only' }),
      ).expect(404);
      const absent = await ingest(
        tokenA,
        validEvent({ deviceKey: 'device-never-registered' }),
      ).expect(404);

      const strip = (body: Record<string, unknown>) => ({
        statusCode: body.statusCode,
        error: body.error,
        message: body.message,
      });

      // Byte-identical apart from the timestamp: ingestion cannot be used to
      // discover which device keys other tenants use.
      expect(strip(foreign.body as Record<string, unknown>)).toEqual(
        strip(absent.body as Record<string, unknown>),
      );
    });

    it('routes each tenant to its own device for a shared device key', async () => {
      const a = await ingest(
        tokenA,
        validEvent({ eventKey: 'evt-shared-key' }),
      ).expect(201);
      const b = await ingest(
        tokenB,
        validEvent({ eventKey: 'evt-shared-key' }),
      ).expect(201);

      const bodyA = a.body as EventBody;
      const bodyB = b.body as EventBody;

      expect(bodyA.tenantId).toBe(tenantAId);
      expect(bodyB.tenantId).toBe(tenantBId);
      expect(bodyA.trackedDeviceId).not.toBe(bodyB.trackedDeviceId);
      expect(await countEvents()).toBe(2);
    });

    it('rejects a client-supplied tenantId and stores nothing', async () => {
      await ingest(tokenA, validEvent({ tenantId: tenantBId })).expect(400);
      expect(await countEvents()).toBe(0);
    });

    it('rejects a client-supplied trackedDeviceId and stores nothing', async () => {
      await ingest(tokenA, validEvent({ trackedDeviceId: deviceAId })).expect(
        400,
      );
      expect(await countEvents()).toBe(0);
    });

    it('stores an event whose tenant always matches its device tenant', async () => {
      await ingest(tokenA, validEvent({ eventKey: 'evt-own-a' })).expect(201);
      await ingest(tokenB, validEvent({ eventKey: 'evt-own-b' })).expect(201);

      const mismatched = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) AS count
        FROM "LocationEvent" e
        JOIN "TrackedDevice" d ON d."id" = e."trackedDeviceId"
        WHERE d."tenantId" <> e."tenantId"
      `;
      expect(Number(mismatched[0].count)).toBe(0);
    });

    it('refuses ingestion for a device the tenant deactivated', async () => {
      await ingest(tokenA, validEvent({ deviceKey: inactiveDeviceKey })).expect(
        409,
      );

      expect(await countEvents()).toBe(0);
    });

    it('still rejects a token whose membership was deleted', async () => {
      const revoked = await register('revoked-gf4@example.com', 'Revoked GF4');
      const membership = await prisma.membership.findFirstOrThrow({
        where: { tenantId: revoked.tenant.id },
      });
      await prisma.membership.delete({ where: { id: membership.id } });

      await request(server)
        .post('/api/v1/location-events')
        .set('Authorization', auth(revoked.accessToken))
        .send(validEvent())
        .expect(401);
    });
  });

  describe('idempotency', () => {
    it('creates exactly one row for the first submission', async () => {
      await ingest(tokenA, validEvent()).expect(201);
      expect(await countEvents()).toBe(1);
    });

    it('returns 200 with the same id for an identical replay', async () => {
      const first = await ingest(tokenA, validEvent()).expect(201);
      const replay = await ingest(tokenA, validEvent()).expect(200);

      const firstBody = first.body as EventBody;
      const replayBody = replay.body as EventBody;

      expect(replayBody.replayed).toBe(true);
      expect(replayBody.id).toBe(firstBody.id);
      // The stored receipt time is the original one; a replay does not re-stamp.
      expect(replayBody.receivedAt).toBe(firstBody.receivedAt);
      expect(await countEvents()).toBe(1);
    });

    it.each([
      ['coordinates', { latitude: 31.1 }],
      ['longitude', { longitude: -96.5 }],
      ['timestamp', { observedAt: '2026-09-09T05:00:00.000Z' }],
      ['accuracy', { accuracyMeters: 12.25 }],
    ])(
      'conflicts, and does not overwrite, when a replay changes %s',
      async (_label, override) => {
        const first = await ingest(tokenA, validEvent()).expect(201);

        const res = await ingest(tokenA, validEvent(override)).expect(409);
        expect((res.body as { message: string }).message).toBe(
          'eventKey already used for a different location event',
        );

        const stored = await prisma.locationEvent.findUniqueOrThrow({
          where: { id: (first.body as EventBody).id },
        });
        expect(stored.latitude).toBe(30.2672);
        expect(stored.longitude).toBe(-97.7431);
        expect(stored.accuracyMeters).toBe(8.5);
        expect(stored.observedAt.toISOString()).toBe(OBSERVED_AT);
        expect(await countEvents()).toBe(1);
      },
    );

    it('lets two tenants use the same event key independently', async () => {
      const a = await ingest(tokenA, validEvent()).expect(201);
      const b = await ingest(tokenB, validEvent()).expect(201);

      expect((a.body as EventBody).id).not.toBe((b.body as EventBody).id);
      expect((b.body as EventBody).replayed).toBe(false);
      expect(await countEvents({ tenantId: tenantAId })).toBe(1);
      expect(await countEvents({ tenantId: tenantBId })).toBe(1);
    });

    it('scopes the key per device, so two devices may reuse it', async () => {
      await registerDevice(tokenA, 'device-a3', 'Van A3');

      await ingest(tokenA, validEvent()).expect(201);
      const second = await ingest(
        tokenA,
        validEvent({ deviceKey: 'device-a3' }),
      ).expect(201);

      expect((second.body as EventBody).replayed).toBe(false);
      expect(await countEvents({ tenantId: tenantAId })).toBe(2);
    });

    it('persists exactly one row under concurrent duplicate submissions', async () => {
      const attempts = 8;
      const responses = await Promise.all(
        Array.from({ length: attempts }, () =>
          ingest(tokenA, validEvent({ eventKey: 'evt-race' })),
        ),
      );

      const statuses = responses.map((res) => res.status);
      const ids = new Set(responses.map((res) => (res.body as EventBody).id));

      // Every request succeeded, exactly one of them as the creator.
      expect(statuses.every((status) => status === 200 || status === 201)).toBe(
        true,
      );
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      // All of them describe the same single stored resource.
      expect(ids.size).toBe(1);
      expect(await countEvents({ eventKey: 'evt-race' })).toBe(1);
    });

    it('keeps concurrent conflicting submissions from creating a second row', async () => {
      const responses = await Promise.all([
        ingest(tokenA, validEvent({ eventKey: 'evt-race-conflict' })),
        ingest(
          tokenA,
          validEvent({ eventKey: 'evt-race-conflict', latitude: 10 }),
        ),
        ingest(
          tokenA,
          validEvent({ eventKey: 'evt-race-conflict', latitude: 20 }),
        ),
      ]);

      expect(
        responses.every((res) => [200, 201, 409].includes(res.status)),
      ).toBe(true);
      expect(await countEvents({ eventKey: 'evt-race-conflict' })).toBe(1);
    });
  });

  describe('validation reaches the database layer', () => {
    it.each([
      ['latitude 91', { latitude: 91 }],
      ['longitude -181', { longitude: -181 }],
      ['negative accuracy', { accuracyMeters: -1 }],
      ['a timezone-free timestamp', { observedAt: '2026-09-09T06:00:00' }],
      ['an impossible date', { observedAt: '2026-02-30T00:00:00.000Z' }],
      ['a far-future timestamp', { observedAt: '2099-01-01T00:00:00.000Z' }],
      ['an unknown property', { hacker: true }],
    ])('rejects %s without persisting anything', async (_label, override) => {
      await ingest(tokenA, validEvent(override)).expect(400);
      expect(await countEvents()).toBe(0);
    });
  });
});
