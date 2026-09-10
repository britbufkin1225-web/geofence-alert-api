import type { Server } from 'http';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { setupApp } from '../../src/app.setup';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  createPrismaService,
  requireDisposableDatabaseUrl,
  truncateAll,
} from './support/database';

/**
 * REAL PostgreSQL/PostGIS proof for GF-8 authenticated, tenant-scoped alert
 * retrieval, driven through the authenticated HTTP routes against the disposable
 * database that `npm run test:db` provisions and migrates.
 *
 * Every alert these tests read was produced the only way an alert can be
 * produced: by ingesting an observation that GF-6 classified as a crossing and
 * GF-7 recorded. Nothing here inserts an alert row directly, so what is being
 * read is the real table with its real constraints, and the read path is being
 * proven against the write path rather than against a fixture that agrees with
 * it by construction.
 *
 * The fixture deliberately produces alerts that SHARE an observation instant:
 * one observation crossing three geofences at once yields three alerts whose
 * `observedAt` is identical. That is the case an ordering without a unique
 * tie-breaker gets wrong, and it cannot be constructed by accident.
 */

interface AuthResponse {
  accessToken: string;
  tenant: { id: string; name: string };
}

interface AlertBody {
  id: string;
  tenantId: string;
  transition: 'ENTER' | 'EXIT';
  observedAt: string;
  createdAt: string;
  trackedDeviceId: string;
  geofenceId: string;
  sourceLocationEventId: string;
}

interface ListBody {
  data: AlertBody[];
  meta: {
    total: number;
    count: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    filters: Record<string, unknown>;
    sort: { sortBy: string; sortOrder: string; tieBreaker: string };
  };
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

// Roughly 11 km north: far outside a 250 m circle, so a geofence the device has
// left is still evaluated and can still report an EXIT.
const FAR = { latitude: 30.3672, longitude: -97.7431 };

const BASE_TIME = Date.parse('2026-09-09T06:00:00.000Z');
const at = (minutes: number) => new Date(BASE_TIME + minutes * 60_000);

/** The instants the fixture ingests at, in the order it ingests them. */
const T_BASELINE = at(0);
const T_ENTER = at(10);
const T_EXIT = at(20);

describe('GF-8 alert retrieval (real PostgreSQL/PostGIS integration)', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;

  let tokenA: string;
  let tokenB: string;
  let tenantAId: string;
  let tenantBId: string;

  let deviceAId: string;
  let deviceBId: string;

  /** Tenant A's three geofences, all centered on AUSTIN. */
  let geofenceAIds: string[];
  let geofenceBId: string;

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

  const createGeofence = async (tenantId: string, name: string) => {
    const geofence = await prisma.geofence.create({
      data: {
        tenantId,
        name,
        latitude: AUSTIN.latitude,
        longitude: AUSTIN.longitude,
        radiusMeters: 250,
      },
      select: { id: true },
    });
    return geofence.id;
  };

  const ingest = (
    token: string,
    deviceKey: string,
    observedAt: Date,
    position: { latitude: number; longitude: number },
  ) =>
    request(server)
      .post('/api/v1/location-events')
      .set('Authorization', `Bearer ${token}`)
      .send({
        deviceKey,
        eventKey: `evt-${++eventSeq}`,
        observedAt: observedAt.toISOString(),
        latitude: position.latitude,
        longitude: position.longitude,
        accuracyMeters: 5,
      })
      .expect(201);

  const list = (token: string, queryString = '') =>
    request(server)
      .get(`/api/v1/alert-events${queryString}`)
      .set('Authorization', `Bearer ${token}`);

  const detail = (token: string, id: string) =>
    request(server)
      .get(`/api/v1/alert-events/${id}`)
      .set('Authorization', `Bearer ${token}`);

  /**
   * The plan PostgreSQL produces for a statement, as one string.
   *
   * The identifiers the callers interpolate are cuids the database itself
   * generated in this run, never request input. EXPLAIN cannot take the query
   * text as a bound parameter, and passing the id as one would have PostgreSQL
   * plan generically instead of for the value the production statement carries.
   */
  const explain = async (sql: string) => {
    const rows =
      await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(sql);
    return rows.map((row) => row['QUERY PLAN']).join('\n');
  };

  /**
   * The same, with sequential scans disabled for the duration of ONE
   * transaction. `SET LOCAL` is scoped to a transaction and has no effect
   * outside one, so both statements must share this transaction client.
   */
  const planWithoutSeqScan = (sql: string) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows =
        await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(sql);
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });

  /** Every alert row in the table, as the database holds it. */
  const allAlertRows = () =>
    prisma.alertEvent.findMany({
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
    });

  beforeAll(async () => {
    requireDisposableDatabaseUrl();
    prisma = createPrismaService();
    await prisma.$connect();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    server = app.getHttpServer() as Server;

    await truncateAll(prisma);

    const a = await register('gf8-a@example.test', 'Tenant A');
    const b = await register('gf8-b@example.test', 'Tenant B');
    tokenA = a.accessToken;
    tokenB = b.accessToken;
    tenantAId = a.tenant.id;
    tenantBId = b.tenant.id;

    // The SAME external device key in both tenants: equivalent identifiers must
    // stay isolated, and a key collision must not make one tenant's alerts
    // reachable from the other.
    deviceAId = await registerDevice(tokenA, 'device-001');
    deviceBId = await registerDevice(tokenB, 'device-001');

    geofenceAIds = [
      await createGeofence(tenantAId, 'Depot'),
      await createGeofence(tenantAId, 'Yard'),
      await createGeofence(tenantAId, 'Dock'),
    ];
    geofenceBId = await createGeofence(tenantBId, 'Depot');

    // Tenant A: outside (baseline, no alerts), then inside (3 simultaneous
    // ENTERs), then outside again (3 simultaneous EXITs) = 6 alerts, in two
    // groups of three that share an observation instant exactly.
    await ingest(tokenA, 'device-001', T_BASELINE, FAR);
    await ingest(tokenA, 'device-001', T_ENTER, AUSTIN);
    await ingest(tokenA, 'device-001', T_EXIT, FAR);

    // Tenant B: one ENTER, at an instant tenant A also has alerts at, so a
    // leaking query would be visibly wrong rather than merely differently
    // ordered.
    await ingest(tokenB, 'device-001', T_BASELINE, FAR);
    await ingest(tokenB, 'device-001', T_ENTER, AUSTIN);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('fixture', () => {
    it('recorded six alerts for tenant A and one for tenant B', async () => {
      const rows = await allAlertRows();

      expect(rows.filter((row) => row.tenantId === tenantAId)).toHaveLength(6);
      expect(rows.filter((row) => row.tenantId === tenantBId)).toHaveLength(1);
    });

    it('produced three tenant-A alerts sharing one observation instant', async () => {
      const rows = await allAlertRows();
      const simultaneous = rows.filter(
        (row) =>
          row.tenantId === tenantAId &&
          row.observedAt.getTime() === T_ENTER.getTime(),
      );

      expect(simultaneous).toHaveLength(3);
      expect(new Set(simultaneous.map((row) => row.id)).size).toBe(3);
    });
  });

  describe('authentication and tenant isolation', () => {
    it('rejects an unauthenticated list', async () => {
      await request(server).get('/api/v1/alert-events').expect(401);
    });

    it('rejects an unauthenticated detail request', async () => {
      const [row] = await allAlertRows();
      await request(server).get(`/api/v1/alert-events/${row.id}`).expect(401);
    });

    it('rejects a token whose membership was deleted', async () => {
      const throwaway = await register('gf8-c@example.test', 'Tenant C');
      await prisma.membership.deleteMany({
        where: { tenantId: throwaway.tenant.id },
      });

      await list(throwaway.accessToken).expect(401);
      await prisma.tenant.delete({ where: { id: throwaway.tenant.id } });
    });

    it('returns only the caller tenant alerts in the list', async () => {
      const body = (await list(tokenA, '?limit=100').expect(200))
        .body as ListBody;

      expect(body.meta.total).toBe(6);
      expect(body.data).toHaveLength(6);
      expect(body.data.every((alert) => alert.tenantId === tenantAId)).toBe(
        true,
      );

      const bBody = (await list(tokenB, '?limit=100').expect(200))
        .body as ListBody;
      expect(bBody.meta.total).toBe(1);
      expect(bBody.data[0].tenantId).toBe(tenantBId);
    });

    it('never returns another tenant alert id in either list', async () => {
      const aIds = (
        (await list(tokenA, '?limit=100').expect(200)).body as ListBody
      ).data.map((alert) => alert.id);
      const bIds = (
        (await list(tokenB, '?limit=100').expect(200)).body as ListBody
      ).data.map((alert) => alert.id);

      expect(aIds.filter((id) => bIds.includes(id))).toEqual([]);
    });

    it('refuses to retrieve another tenant alert by id', async () => {
      const rows = await allAlertRows();
      const tenantAAlert = rows.find((row) => row.tenantId === tenantAId)!;

      await detail(tokenB, tenantAAlert.id).expect(404);
      await detail(tokenA, tenantAAlert.id).expect(200);
    });

    it('answers a foreign id and a never-issued id identically', async () => {
      const rows = await allAlertRows();
      const tenantAAlert = rows.find((row) => row.tenantId === tenantAId)!;

      const foreign = (await detail(tokenB, tenantAAlert.id).expect(404))
        .body as ErrorBody;
      const missing = (
        await detail(tokenB, 'cnosuchalertaaaaaaaaaaaaa').expect(404)
      ).body as ErrorBody;

      expect(foreign.statusCode).toBe(missing.statusCode);
      expect(foreign.error).toBe(missing.error);
      expect(String(foreign.message).replace(tenantAAlert.id, 'ID')).toBe(
        String(missing.message).replace('cnosuchalertaaaaaaaaaaaaa', 'ID'),
      );
    });

    it('cannot be re-scoped by a tenant query parameter', async () => {
      await list(tokenB, `?tenantId=${tenantAId}`).expect(400);
    });

    it('cannot be re-scoped by a tenant header', async () => {
      const body = (
        await request(server)
          .get('/api/v1/alert-events?limit=100')
          .set('Authorization', `Bearer ${tokenB}`)
          .set('X-Tenant-Id', tenantAId)
          .expect(200)
      ).body as ListBody;

      expect(body.meta.total).toBe(1);
      expect(body.data.every((alert) => alert.tenantId === tenantBId)).toBe(
        true,
      );
    });

    it('keeps equivalent device keys in separate tenants isolated', async () => {
      // Both tenants registered 'device-001'; the ids differ and neither can
      // see the other's alerts through its own device filter.
      const aBody = (
        await list(tokenA, `?trackedDeviceId=${deviceAId}&limit=100`).expect(
          200,
        )
      ).body as ListBody;
      const bBody = (
        await list(tokenB, `?trackedDeviceId=${deviceBId}&limit=100`).expect(
          200,
        )
      ).body as ListBody;

      expect(aBody.meta.total).toBe(6);
      expect(bBody.meta.total).toBe(1);
      expect(deviceAId).not.toBe(deviceBId);
    });

    it('answers a foreign geofence filter with an empty page, not a leak', async () => {
      const body = (
        await list(tokenB, `?geofenceId=${geofenceAIds[0]}&limit=100`).expect(
          200,
        )
      ).body as ListBody;

      expect(body.data).toEqual([]);
      expect(body.meta.total).toBe(0);

      // The same filter shape against tenant B's OWN geofence returns its alert,
      // so the empty page above is tenant scope doing its job rather than the
      // filter being broken for everyone.
      const own = (
        await list(tokenB, `?geofenceId=${geofenceBId}&limit=100`).expect(200)
      ).body as ListBody;

      expect(own.meta.total).toBe(1);
      expect(own.data[0].geofenceId).toBe(geofenceBId);
    });

    it('answers a foreign device filter with an empty page', async () => {
      const body = (
        await list(tokenB, `?trackedDeviceId=${deviceAId}&limit=100`).expect(
          200,
        )
      ).body as ListBody;

      expect(body.data).toEqual([]);
      expect(body.meta.total).toBe(0);
    });
  });

  describe('deterministic ordering', () => {
    it('returns the caller tenant alerts newest observation first', async () => {
      const body = (await list(tokenA, '?limit=100').expect(200))
        .body as ListBody;

      const instants = body.data.map((alert) => Date.parse(alert.observedAt));
      expect(instants).toEqual([...instants].sort((a, b) => b - a));
      expect(instants[0]).toBe(T_EXIT.getTime());
      expect(instants[instants.length - 1]).toBe(T_ENTER.getTime());
    });

    it('breaks an exact tie by descending id', async () => {
      const body = (await list(tokenA, '?limit=100').expect(200))
        .body as ListBody;

      const tied = body.data.filter(
        (alert) => Date.parse(alert.observedAt) === T_ENTER.getTime(),
      );

      expect(tied).toHaveLength(3);
      expect(tied.map((alert) => alert.id)).toEqual(
        [...tied.map((alert) => alert.id)].sort().reverse(),
      );
    });

    it('returns the identical ordered response on a repeated read', async () => {
      const first = (await list(tokenA, '?limit=100').expect(200))
        .body as ListBody;
      const second = (await list(tokenA, '?limit=100').expect(200))
        .body as ListBody;

      expect(second).toEqual(first);
    });

    it('reports the total order it actually applied', async () => {
      const body = (await list(tokenA).expect(200)).body as ListBody;

      expect(body.meta.sort).toEqual({
        sortBy: 'observedAt',
        sortOrder: 'desc',
        tieBreaker: 'id',
      });
    });
  });

  describe('pagination', () => {
    it('never repeats or drops an alert across adjacent pages', async () => {
      const collected: string[] = [];

      for (let page = 1; page <= 6; page += 1) {
        const body = (await list(tokenA, `?page=${page}&limit=1`).expect(200))
          .body as ListBody;
        expect(body.meta.total).toBe(6);
        collected.push(...body.data.map((alert) => alert.id));
      }

      const whole = (await list(tokenA, '?limit=100').expect(200))
        .body as ListBody;

      expect(collected).toHaveLength(6);
      expect(new Set(collected).size).toBe(6);
      // Paged one at a time, the sequence is exactly the single-page order.
      expect(collected).toEqual(whole.data.map((alert) => alert.id));
    });

    it('cuts pages at the tie boundary without duplicating a tied alert', async () => {
      // limit=2 splits the three simultaneous EXIT alerts across pages 1 and 2.
      const first = (await list(tokenA, '?page=1&limit=2').expect(200))
        .body as ListBody;
      const second = (await list(tokenA, '?page=2&limit=2').expect(200))
        .body as ListBody;

      const ids = [...first.data, ...second.data].map((alert) => alert.id);
      expect(new Set(ids).size).toBe(4);
    });

    it('reports consistent metadata on a partial final page', async () => {
      const body = (await list(tokenA, '?page=3&limit=4').expect(200))
        .body as ListBody;

      expect(body.meta).toMatchObject({
        total: 6,
        count: 0,
        page: 3,
        limit: 4,
        totalPages: 2,
        hasNextPage: false,
        hasPreviousPage: true,
      });

      const partial = (await list(tokenA, '?page=2&limit=4').expect(200))
        .body as ListBody;
      expect(partial.meta).toMatchObject({
        total: 6,
        count: 2,
        totalPages: 2,
        hasNextPage: false,
      });
      expect(partial.data).toHaveLength(2);
    });

    it('answers a page far past the end with success and an empty collection', async () => {
      const body = (await list(tokenA, '?page=500&limit=10').expect(200))
        .body as ListBody;

      expect(body.data).toEqual([]);
      expect(body.meta.total).toBe(6);
      expect(body.meta.count).toBe(0);
    });

    it('rejects a limit above the maximum', async () => {
      await list(tokenA, '?limit=101').expect(400);
      await list(tokenA, '?limit=100').expect(200);
    });
  });

  describe('filters', () => {
    it('returns only ENTER alerts for the ENTER filter', async () => {
      const body = (
        await list(tokenA, '?transition=ENTER&limit=100').expect(200)
      ).body as ListBody;

      expect(body.meta.total).toBe(3);
      expect(body.data.every((alert) => alert.transition === 'ENTER')).toBe(
        true,
      );
    });

    it('returns only EXIT alerts for the EXIT filter', async () => {
      const body = (
        await list(tokenA, '?transition=EXIT&limit=100').expect(200)
      ).body as ListBody;

      expect(body.meta.total).toBe(3);
      expect(body.data.every((alert) => alert.transition === 'EXIT')).toBe(
        true,
      );
    });

    it('rejects a transition that is not a crossing', async () => {
      await list(tokenA, '?transition=STAY_INSIDE').expect(400);
      await list(tokenA, '?transition=BASELINE_OUTSIDE').expect(400);
    });

    it('filters by geofence exactly', async () => {
      const body = (
        await list(tokenA, `?geofenceId=${geofenceAIds[0]}&limit=100`).expect(
          200,
        )
      ).body as ListBody;

      expect(body.meta.total).toBe(2);
      expect(
        body.data.every((alert) => alert.geofenceId === geofenceAIds[0]),
      ).toBe(true);
    });

    it('filters by source location event exactly', async () => {
      const rows = await allAlertRows();
      const enterEventId = rows.find(
        (row) =>
          row.tenantId === tenantAId &&
          row.observedAt.getTime() === T_ENTER.getTime(),
      )!.sourceLocationEventId;

      const body = (
        await list(
          tokenA,
          `?sourceLocationEventId=${enterEventId}&limit=100`,
        ).expect(200)
      ).body as ListBody;

      expect(body.meta.total).toBe(3);
      expect(
        body.data.every(
          (alert) => alert.sourceLocationEventId === enterEventId,
        ),
      ).toBe(true);
    });

    it('treats the lower bound as inclusive, at the exact boundary', async () => {
      const inclusive = (
        await list(
          tokenA,
          `?observedFrom=${T_EXIT.toISOString()}&limit=100`,
        ).expect(200)
      ).body as ListBody;

      // The three EXIT alerts sit exactly on the bound and are included.
      expect(inclusive.meta.total).toBe(3);
      expect(
        inclusive.data.every(
          (alert) => Date.parse(alert.observedAt) === T_EXIT.getTime(),
        ),
      ).toBe(true);

      const oneMillisecondLater = new Date(T_EXIT.getTime() + 1);
      const exclusive = (
        await list(
          tokenA,
          `?observedFrom=${oneMillisecondLater.toISOString()}&limit=100`,
        ).expect(200)
      ).body as ListBody;
      expect(exclusive.meta.total).toBe(0);
    });

    it('treats the upper bound as exclusive, at the exact boundary', async () => {
      const excluded = (
        await list(
          tokenA,
          `?observedBefore=${T_ENTER.toISOString()}&limit=100`,
        ).expect(200)
      ).body as ListBody;

      // The three ENTER alerts sit exactly on the bound and are excluded.
      expect(excluded.meta.total).toBe(0);

      const oneMillisecondLater = new Date(T_ENTER.getTime() + 1);
      const included = (
        await list(
          tokenA,
          `?observedBefore=${oneMillisecondLater.toISOString()}&limit=100`,
        ).expect(200)
      ).body as ListBody;
      expect(included.meta.total).toBe(3);
    });

    it('tiles adjacent half-open windows without gap or overlap', async () => {
      const boundary = new Date(T_EXIT.getTime());
      const earlier = (
        await list(
          tokenA,
          `?observedBefore=${boundary.toISOString()}&limit=100`,
        ).expect(200)
      ).body as ListBody;
      const later = (
        await list(
          tokenA,
          `?observedFrom=${boundary.toISOString()}&limit=100`,
        ).expect(200)
      ).body as ListBody;

      const ids = [...earlier.data, ...later.data].map((alert) => alert.id);
      expect(ids).toHaveLength(6);
      expect(new Set(ids).size).toBe(6);
    });

    it('applies both bounds to the observation instant, not the recording time', async () => {
      // Every alert was recorded (createdAt) during this test run, long after
      // the 2026-09-09 observation instants. A window that ends before the test
      // run started still matches, which it could not if createdAt were used.
      const body = (
        await list(
          tokenA,
          `?observedFrom=${T_ENTER.toISOString()}` +
            `&observedBefore=${new Date(T_EXIT.getTime() + 1).toISOString()}` +
            '&limit=100',
        ).expect(200)
      ).body as ListBody;

      expect(body.meta.total).toBe(6);
    });

    it('rejects an invalid timestamp and a reversed window', async () => {
      await list(tokenA, '?observedFrom=not-a-date').expect(400);
      await list(
        tokenA,
        `?observedFrom=${T_EXIT.toISOString()}&observedBefore=${T_ENTER.toISOString()}`,
      ).expect(400);
    });

    it('combines filters with AND semantics and a matching total', async () => {
      const body = (
        await list(
          tokenA,
          `?transition=ENTER&geofenceId=${geofenceAIds[1]}` +
            `&trackedDeviceId=${deviceAId}` +
            `&observedFrom=${T_ENTER.toISOString()}&limit=100`,
        ).expect(200)
      ).body as ListBody;

      expect(body.meta.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.meta.count).toBe(1);
      expect(body.data[0]).toMatchObject({
        transition: 'ENTER',
        geofenceId: geofenceAIds[1],
        trackedDeviceId: deviceAId,
      });
    });

    it('keeps total and count describing the same filtered set', async () => {
      const filtered = (
        await list(tokenA, '?transition=EXIT&limit=1').expect(200)
      ).body as ListBody;

      expect(filtered.meta.total).toBe(3);
      expect(filtered.meta.count).toBe(1);
      expect(filtered.data).toHaveLength(1);
      expect(filtered.meta.totalPages).toBe(3);
    });

    it('cannot be widened by an injection-shaped filter value', async () => {
      for (const value of ["' OR 1=1 --", `${geofenceAIds[0]}' OR '1'='1`]) {
        await list(tokenA, `?geofenceId=${encodeURIComponent(value)}`).expect(
          400,
        );
      }

      // And a well-formed id that simply does not exist matches nothing rather
      // than everything.
      const body = (
        await list(
          tokenA,
          '?geofenceId=cnosuchgeofenceaaaaaaaaaa&limit=100',
        ).expect(200)
      ).body as ListBody;
      expect(body.meta.total).toBe(0);
    });
  });

  describe('detail contract', () => {
    it('returns a same-tenant alert', async () => {
      const rows = await allAlertRows();
      const alert = rows.find((row) => row.tenantId === tenantAId)!;

      const body = (await detail(tokenA, alert.id).expect(200))
        .body as AlertBody;

      expect(body.id).toBe(alert.id);
      expect(body.tenantId).toBe(tenantAId);
      expect(body.observedAt).toBe(alert.observedAt.toISOString());
    });

    it('returns exactly the same object the list returns for that alert', async () => {
      const listed = (await list(tokenA, '?limit=100').expect(200))
        .body as ListBody;

      for (const item of listed.data) {
        const single = (await detail(tokenA, item.id).expect(200))
          .body as AlertBody;
        expect(single).toEqual(item);
      }
    });

    it('rejects a malformed id with 400 before touching the database', async () => {
      const body = (await detail(tokenA, 'not-a-cuid').expect(400))
        .body as ErrorBody;
      expect(body.message).toBe('Invalid alert event id format');
    });

    it('returns 404 for a well-formed id that names nothing', async () => {
      await detail(tokenA, 'cnosuchalertaaaaaaaaaaaaa').expect(404);
    });
  });

  describe('public representation', () => {
    it('publishes exactly the eight documented fields', async () => {
      const body = (await list(tokenA, '?limit=100').expect(200))
        .body as ListBody;

      for (const alert of body.data) {
        expect(Object.keys(alert).sort()).toEqual([
          'createdAt',
          'geofenceId',
          'id',
          'observedAt',
          'sourceLocationEventId',
          'tenantId',
          'trackedDeviceId',
          'transition',
        ]);
      }
    });

    it('exposes no legacy, workflow, spatial or bookkeeping column', async () => {
      const serialized = JSON.stringify(
        (await list(tokenA, '?limit=100').expect(200)).body,
      );

      // Matched as JSON keys rather than as bare substrings: `source` is a real
      // column name AND a prefix of the published `sourceLocationEventId`, so a
      // substring test would pass or fail for the wrong reason.
      for (const column of [
        'severity',
        'status',
        'eventType',
        'message',
        'source',
        'latitude',
        'longitude',
        'updatedAt',
        'passwordHash',
      ]) {
        expect(serialized).not.toContain(`"${column}":`);
      }

      for (const leaked of [
        'accessToken',
        'AlertEvent_crossing_key',
        'SELECT',
        'prisma',
      ]) {
        expect(serialized).not.toContain(leaked);
      }
    });

    it('reports only crossing transitions', async () => {
      const body = (await list(tokenA, '?limit=100').expect(200))
        .body as ListBody;

      expect(
        body.data.every((alert) =>
          ['ENTER', 'EXIT'].includes(alert.transition),
        ),
      ).toBe(true);
    });
  });

  describe('reads are read-only', () => {
    it('changes no alert row, count or timestamp', async () => {
      const before = await allAlertRows();

      await list(tokenA, '?limit=100').expect(200);
      await list(tokenA, '?transition=ENTER&page=2&limit=1').expect(200);
      await list(tokenB, '?limit=100').expect(200);
      await detail(tokenA, before[0].id).expect(200);
      await detail(tokenB, before[0].id).expect(404);
      await list(tokenA, '?page=500').expect(200);

      const after = await allAlertRows();

      expect(after).toEqual(before);
    });

    it('creates no alert for a tenant that has never crossed a boundary', async () => {
      const quiet = await register('gf8-d@example.test', 'Tenant D');

      const body = (await list(quiet.accessToken, '?limit=100').expect(200))
        .body as ListBody;
      expect(body.data).toEqual([]);
      expect(body.meta.total).toBe(0);

      const rows = await prisma.alertEvent.count({
        where: { tenantId: quiet.tenant.id },
      });
      expect(rows).toBe(0);

      await prisma.tenant.delete({ where: { id: quiet.tenant.id } });
    });

    it('advances no GF-6 transition state', async () => {
      const before = await prisma.geofenceDeviceState.findMany({
        orderBy: [{ tenantId: 'asc' }, { geofenceId: 'asc' }],
      });

      await list(tokenA, '?limit=100').expect(200);
      const rows = await allAlertRows();
      await detail(tokenA, rows[0].id).expect(200);

      const after = await prisma.geofenceDeviceState.findMany({
        orderBy: [{ tenantId: 'asc' }, { geofenceId: 'asc' }],
      });

      expect(after).toEqual(before);
    });

    it('ingests no location event', async () => {
      const before = await prisma.locationEvent.count();
      await list(tokenA, '?limit=100').expect(200);
      expect(await prisma.locationEvent.count()).toBe(before);
    });
  });

  describe('schema and query proof', () => {
    it('has the GF-8 ordering index in the PostgreSQL catalog', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ indexdef: string }>
      >`SELECT indexdef FROM pg_indexes
         WHERE tablename = 'AlertEvent'
           AND indexname = 'AlertEvent_tenantId_observedAt_id_idx'`;

      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toContain('"tenantId"');
      expect(rows[0].indexdef).toContain('"observedAt" DESC');
      expect(rows[0].indexdef).toContain('id DESC');
    });

    it('still has every GF-7 index and constraint', async () => {
      const indexes = await prisma.$queryRaw<
        Array<{ indexname: string }>
      >`SELECT indexname FROM pg_indexes WHERE tablename = 'AlertEvent'`;
      const names = indexes.map((row) => row.indexname).sort();

      expect(names).toEqual([
        'AlertEvent_crossing_key',
        'AlertEvent_pkey',
        'AlertEvent_tenantId_geofenceId_idx',
        'AlertEvent_tenantId_observedAt_id_idx',
        'AlertEvent_tenantId_sourceLocationEventId_idx',
      ]);

      const constraints = await prisma.$queryRaw<
        Array<{ conname: string; def: string }>
      >`SELECT conname, pg_get_constraintdef(oid) AS def
          FROM pg_constraint
         WHERE conrelid = '"AlertEvent"'::regclass
           AND contype IN ('f', 'c', 'p')`;
      const byName = new Map(
        constraints.map((row) => [row.conname, row.def] as const),
      );

      // Tenant-consistent composite foreign keys (GF-7).
      for (const [name, columns] of [
        ['AlertEvent_geofenceId_tenantId_fkey', '"Geofence"(id, "tenantId")'],
        [
          'AlertEvent_trackedDeviceId_tenantId_fkey',
          '"TrackedDevice"(id, "tenantId")',
        ],
        [
          'AlertEvent_sourceLocationEventId_tenantId_fkey',
          '"LocationEvent"(id, "tenantId")',
        ],
      ] as const) {
        expect(byName.get(name)).toContain(columns);
      }

      // Crossing-only CHECK (GF-7).
      expect(byName.get('AlertEvent_transition_crossing_check')).toContain(
        'ENTER',
      );
    });

    it('added no GF-8 mutation, delivery or acknowledgement column', async () => {
      const columns = await prisma.$queryRaw<
        Array<{ column_name: string }>
      >`SELECT column_name FROM information_schema.columns
         WHERE table_name = 'AlertEvent'`;
      const names = columns.map((row) => row.column_name).sort();

      expect(names).toEqual([
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

    it('added no alert delivery, outbox, queue or acknowledgement table', async () => {
      const tables = await prisma.$queryRaw<
        Array<{ table_name: string }>
      >`SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
      const names = tables.map((row) => row.table_name);

      for (const forbidden of [
        'AlertDelivery',
        'AlertAcknowledgement',
        'Outbox',
        'AlertNotification',
        'AlertQueue',
        'Webhook',
      ]) {
        expect(names).not.toContain(forbidden);
      }
    });

    it('can satisfy the whole ordering from the GF-8 index, with no sort', async () => {
      // A sequential scan is the correct plan for a seven-row table, so on this
      // fixture the planner choosing one proves nothing either way. Disabling
      // the alternative for one transaction answers the question this test is
      // actually asking: can the index serve the tenant predicate and both
      // ordering components on its own, without a sort step? What the planner
      // picks unaided, at a volume where the choice is real, is proven below.
      const text = await planWithoutSeqScan(
        `EXPLAIN SELECT "id", "tenantId", "transition", "observedAt", "createdAt",
                        "trackedDeviceId", "geofenceId", "sourceLocationEventId"
           FROM "AlertEvent"
          WHERE "tenantId" = '${tenantAId}'
          ORDER BY "observedAt" DESC, "id" DESC
          LIMIT 10`,
      );

      expect(text).toContain('AlertEvent_tenantId_observedAt_id_idx');
      // The index supplies the order, so no separate sort is required.
      expect(text).not.toContain('Sort Key');
    });

    it('can satisfy the tenant-scoped detail lookup from an index', async () => {
      const rows = await allAlertRows();
      const text = await planWithoutSeqScan(
        `EXPLAIN SELECT "id" FROM "AlertEvent"
          WHERE "id" = '${rows[0].id}' AND "tenantId" = '${tenantAId}'
          LIMIT 1`,
      );

      // Which index wins is a cost decision that legitimately changes with
      // volume — the primary key at scale, the covering composite index on a
      // seven-row table. What must hold either way is that an index serves the
      // lookup and that BOTH the id and the tenant are index conditions, so the
      // tenant boundary is enforced by the scan rather than by the application
      // after the row has already been read.
      expect(text).toMatch(/Index (Only )?Scan/);
      expect(text).not.toContain('Seq Scan');

      const indexCond = /Index Cond: \(([^\n]*)\)/.exec(text)?.[1] ?? '';
      expect(indexCond).toContain('tenantId');
      expect(indexCond).toContain('id');
    });
  });

  /**
   * Query plans at a volume where the planner's own choice is evidence.
   *
   * The suite above reads seven alerts, which is the right size for proving
   * behavior and the wrong size for proving a plan: PostgreSQL will scan a
   * one-page table sequentially whatever indexes exist, and it is right to. This
   * block builds a separate tenant with enough alerts that an index is genuinely
   * the cheaper plan, then inspects what the planner picks with nothing
   * disabled.
   *
   * These rows are inserted directly rather than ingested, deliberately and only
   * here: nothing in this block asserts read SEMANTICS — those are proven above
   * against alerts GF-7 actually produced — and driving 2,000 crossings through
   * the HTTP path would add nothing to a plan while taking minutes. The tenant is
   * deleted afterwards and its rows cascade with it.
   */
  describe('query plans at realistic volume', () => {
    const VOLUME = 2_000;
    let bulkTenantId: string;

    beforeAll(async () => {
      const bulk = await register('gf8-volume@example.test', 'Tenant Volume');
      bulkTenantId = bulk.tenant.id;

      const deviceId = await registerDevice(bulk.accessToken, 'device-bulk');
      const geofenceId = await createGeofence(bulkTenantId, 'Bulk');

      const events = Array.from({ length: VOLUME }, (_, index) => ({
        id: `cbulkevt${String(index).padStart(17, '0')}`,
        tenantId: bulkTenantId,
        trackedDeviceId: deviceId,
        eventKey: `bulk-${index}`,
        observedAt: new Date(BASE_TIME + index * 1_000),
        latitude: AUSTIN.latitude,
        longitude: AUSTIN.longitude,
        accuracyMeters: 5,
      }));

      await prisma.locationEvent.createMany({ data: events });
      await prisma.alertEvent.createMany({
        data: events.map((event) => ({
          tenantId: bulkTenantId,
          trackedDeviceId: deviceId,
          geofenceId,
          sourceLocationEventId: event.id,
          transition: 'ENTER' as const,
          observedAt: event.observedAt,
        })),
      });

      // Real statistics, so the planner chooses on this table rather than on the
      // defaults it assumes for one it has never seen.
      await prisma.$executeRawUnsafe('ANALYZE "AlertEvent"');
    });

    afterAll(async () => {
      await prisma.tenant.delete({ where: { id: bulkTenantId } });
      await prisma.$executeRawUnsafe('ANALYZE "AlertEvent"');
    });

    it('holds enough alerts for a plan to be meaningful', async () => {
      const total = await prisma.alertEvent.count({
        where: { tenantId: bulkTenantId },
      });
      expect(total).toBe(VOLUME);
    });

    it('chooses the GF-8 index unaided for the default list page', async () => {
      const text = await explain(
        `EXPLAIN SELECT "id", "tenantId", "transition", "observedAt", "createdAt",
                        "trackedDeviceId", "geofenceId", "sourceLocationEventId"
           FROM "AlertEvent"
          WHERE "tenantId" = '${bulkTenantId}'
          ORDER BY "observedAt" DESC, "id" DESC
          LIMIT 10`,
      );

      expect(text).toContain('AlertEvent_tenantId_observedAt_id_idx');
      expect(text).not.toContain('Seq Scan');
      expect(text).not.toContain('Sort Key');
    });

    it('chooses the GF-8 index unaided for a deep page', async () => {
      const text = await explain(
        `EXPLAIN SELECT "id" FROM "AlertEvent"
          WHERE "tenantId" = '${bulkTenantId}'
          ORDER BY "observedAt" DESC, "id" DESC
          OFFSET 500 LIMIT 10`,
      );

      expect(text).toContain('AlertEvent_tenantId_observedAt_id_idx');
      expect(text).not.toContain('Sort Key');
    });

    it('keeps the index and adds the filter as a predicate when filtering', async () => {
      const text = await explain(
        `EXPLAIN SELECT "id" FROM "AlertEvent"
          WHERE "tenantId" = '${bulkTenantId}' AND "transition" = 'ENTER'
          ORDER BY "observedAt" DESC, "id" DESC
          LIMIT 10`,
      );

      expect(text).toContain('AlertEvent_tenantId_observedAt_id_idx');
      expect(text).not.toContain('Seq Scan');
    });

    it('uses the index for a bounded observation window', async () => {
      const from = new Date(BASE_TIME + 1_000_000).toISOString();
      const text = await explain(
        `EXPLAIN SELECT "id" FROM "AlertEvent"
          WHERE "tenantId" = '${bulkTenantId}'
            AND "observedAt" >= '${from}'::timestamptz
          ORDER BY "observedAt" DESC, "id" DESC
          LIMIT 10`,
      );

      expect(text).toContain('AlertEvent_tenantId_observedAt_id_idx');
      expect(text).not.toContain('Seq Scan');
    });

    it('chooses the primary key unaided for a detail lookup', async () => {
      const [row] = await prisma.alertEvent.findMany({
        where: { tenantId: bulkTenantId },
        select: { id: true },
        take: 1,
      });

      const text = await explain(
        `EXPLAIN SELECT "id" FROM "AlertEvent"
          WHERE "id" = '${row.id}' AND "tenantId" = '${bulkTenantId}'
          LIMIT 1`,
      );

      expect(text).toContain('AlertEvent_pkey');
      expect(text).toContain('tenantId');
      expect(text).not.toContain('Seq Scan');
    });

    it('counts a selective window from the index', async () => {
      const from = new Date(BASE_TIME + (VOLUME - 20) * 1_000).toISOString();
      const text = await explain(
        `EXPLAIN SELECT count(*) FROM "AlertEvent"
          WHERE "tenantId" = '${bulkTenantId}'
            AND "observedAt" >= '${from}'::timestamptz`,
      );

      expect(text).toContain('AlertEvent_tenantId_observedAt_id_idx');
      expect(text).not.toContain('Seq Scan');
    });

    it('scopes the count by tenant in the plan even when it scans', async () => {
      // A filter that matches nearly every row in the table is cheaper to answer
      // by reading the table, and PostgreSQL choosing that is correct rather than
      // a missing index — an index adds nothing when almost everything qualifies.
      // The property GF-8 depends on is not which scan is used but that the
      // tenant predicate is evaluated by the database, which it is in both plans.
      const text = await explain(
        `EXPLAIN SELECT count(*) FROM "AlertEvent"
          WHERE "tenantId" = '${bulkTenantId}' AND "transition" = 'ENTER'`,
      );

      const predicate =
        /(?:Filter|Index Cond): \(([^\n]*)\)/.exec(text)?.[1] ?? '';
      expect(predicate).toContain('tenantId');
    });
  });
});
