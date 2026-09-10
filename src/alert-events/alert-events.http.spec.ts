import type { Server } from 'http';

import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../app.module';
import { setupApp } from '../app.setup';
import { PrismaService } from '../prisma/prisma.service';

/**
 * HTTP-level contract tests for the GF-8 alert read endpoints.
 *
 * A real Nest application is booted with the production `setupApp()`
 * configuration and a mocked Prisma layer, so these prove routing, the global
 * prefix, the validation pipe's allowlist, the authentication guard, the
 * 200/400/401/404 status contract and the error envelope without a database.
 *
 * Real tenant isolation, real ordering, real pagination boundaries and the proof
 * that these routes write nothing are in
 * test/integration/alert-retrieval.integration-spec.ts.
 */

const AUTH_TENANT = 'ctenantaaaaaaaaaaaaaaaaaa';
const AUTH_USER = 'cuseraaaaaaaaaaaaaaaaaaaaa';
const AUTH_MEMBERSHIP = 'cmembaaaaaaaaaaaaaaaaaaaaa';
const OTHER_TENANT = 'ctenantbbbbbbbbbbbbbbbbbb';

const DEVICE_ID = 'cdeviceaaaaaaaaaaaaaaaaaa';
const GEOFENCE_ID = 'cgeofenceaaaaaaaaaaaaaaaa';
const EVENT_ID = 'ceventaaaaaaaaaaaaaaaaaaa';
const ALERT_ID = 'calertaaaaaaaaaaaaaaaaaaa';

const OBSERVED_AT = '2026-09-09T06:00:00.000Z';
const CREATED_AT = '2026-09-09T06:00:02.000Z';

const storedRow = {
  id: ALERT_ID,
  tenantId: AUTH_TENANT,
  transition: 'ENTER',
  observedAt: new Date(OBSERVED_AT),
  createdAt: new Date(CREATED_AT),
  trackedDeviceId: DEVICE_ID,
  geofenceId: GEOFENCE_ID,
  sourceLocationEventId: EVENT_ID,
};

const publicAlert = {
  id: ALERT_ID,
  tenantId: AUTH_TENANT,
  transition: 'ENTER',
  observedAt: OBSERVED_AT,
  createdAt: CREATED_AT,
  trackedDeviceId: DEVICE_ID,
  geofenceId: GEOFENCE_ID,
  sourceLocationEventId: EVENT_ID,
};

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
}

interface ListBody {
  data: Record<string, unknown>[];
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

describe('Alert event retrieval (HTTP)', () => {
  let app: INestApplication;
  let server: Server;
  let authHeader: string;

  const mockPrisma = {
    membership: { findFirst: jest.fn() },
    alertEvent: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      createMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
  };

  const list = (queryString = '') =>
    request(server)
      .get(`/api/v1/alert-events${queryString}`)
      .set('Authorization', authHeader);

  const detail = (id: string) =>
    request(server)
      .get(`/api/v1/alert-events/${id}`)
      .set('Authorization', authHeader);

  const expectNoWrites = () => {
    for (const method of [
      'create',
      'createMany',
      'update',
      'updateMany',
      'delete',
      'deleteMany',
    ] as const) {
      expect(mockPrisma.alertEvent[method]).not.toHaveBeenCalled();
    }
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(mockPrisma)
      .compile();

    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    server = app.getHttpServer() as Server;

    const jwt = app.get(JwtService, { strict: false });
    authHeader = `Bearer ${await jwt.signAsync({
      sub: AUTH_USER,
      tid: AUTH_TENANT,
      mid: AUTH_MEMBERSHIP,
    })}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.membership.findFirst.mockResolvedValue({ id: AUTH_MEMBERSHIP });
    mockPrisma.alertEvent.findMany.mockResolvedValue([storedRow]);
    mockPrisma.alertEvent.count.mockResolvedValue(1);
    mockPrisma.alertEvent.findFirst.mockResolvedValue(storedRow);
    mockPrisma.$transaction.mockImplementation((operations: unknown[]) =>
      Promise.all(operations),
    );
  });

  describe('authentication', () => {
    it('rejects an anonymous list with 401', async () => {
      await request(server).get('/api/v1/alert-events').expect(401);
      expect(mockPrisma.alertEvent.findMany).not.toHaveBeenCalled();
    });

    it('rejects an anonymous detail request with 401', async () => {
      await request(server).get(`/api/v1/alert-events/${ALERT_ID}`).expect(401);
      expect(mockPrisma.alertEvent.findFirst).not.toHaveBeenCalled();
    });

    it('rejects a malformed bearer token with 401', async () => {
      await request(server)
        .get('/api/v1/alert-events')
        .set('Authorization', 'Bearer not-a-real-token')
        .expect(401);
    });

    it('rejects a non-bearer scheme with 401', async () => {
      await request(server)
        .get('/api/v1/alert-events')
        .set('Authorization', 'Basic dXNlcjpwYXNz')
        .expect(401);
    });

    it('rejects an expired token with 401', async () => {
      const jwt = app.get(JwtService, { strict: false });
      const expired = await jwt.signAsync(
        { sub: AUTH_USER, tid: AUTH_TENANT, mid: AUTH_MEMBERSHIP },
        { expiresIn: -10 },
      );

      await request(server)
        .get('/api/v1/alert-events')
        .set('Authorization', `Bearer ${expired}`)
        .expect(401);
    });

    it('rejects a token whose membership no longer exists with 401', async () => {
      mockPrisma.membership.findFirst.mockResolvedValue(null);

      await list().expect(401);
      await detail(ALERT_ID).expect(401);
      expect(mockPrisma.alertEvent.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.alertEvent.findFirst).not.toHaveBeenCalled();
    });

    it('revalidates the exact membership tuple from the token', async () => {
      await list().expect(200);

      expect(mockPrisma.membership.findFirst).toHaveBeenCalledWith({
        where: {
          id: AUTH_MEMBERSHIP,
          userId: AUTH_USER,
          tenantId: AUTH_TENANT,
        },
        select: { id: true },
      });
    });

    it('is not exposed without the /api/v1 prefix', async () => {
      await request(server)
        .get('/alert-events')
        .set('Authorization', authHeader)
        .expect(404);
    });
  });

  describe('tenant scope cannot be supplied by the caller', () => {
    it('rejects a tenantId query parameter as an unknown property', async () => {
      const response = await list(`?tenantId=${OTHER_TENANT}`).expect(400);

      const body = response.body as ErrorBody;
      expect(JSON.stringify(body.message)).toContain('tenantId');
      expect(mockPrisma.alertEvent.findMany).not.toHaveBeenCalled();
    });

    it('rejects userId, membershipId and other ownership overrides', async () => {
      for (const parameter of ['userId', 'membershipId', 'tenant', 'owner']) {
        await list(`?${parameter}=${OTHER_TENANT}`).expect(400);
      }
      expect(mockPrisma.alertEvent.findMany).not.toHaveBeenCalled();
    });

    it('ignores a tenant-like header and still scopes to the token', async () => {
      await request(server)
        .get('/api/v1/alert-events')
        .set('Authorization', authHeader)
        .set('X-Tenant-Id', OTHER_TENANT)
        .set('X-Tenant', OTHER_TENANT)
        .expect(200);

      const [args] = mockPrisma.alertEvent.findMany.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(args.where.tenantId).toBe(AUTH_TENANT);
    });

    it('scopes the detail lookup to the token tenant', async () => {
      await detail(ALERT_ID).expect(200);

      expect(mockPrisma.alertEvent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: ALERT_ID, tenantId: AUTH_TENANT },
        }),
      );
    });
  });

  describe('list contract', () => {
    it('returns 200 with the data/meta envelope', async () => {
      const response = await list().expect(200);
      const body = response.body as ListBody;

      expect(body.data).toEqual([publicAlert]);
      expect(body.meta).toEqual({
        total: 1,
        count: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        filters: {
          transition: null,
          trackedDeviceId: null,
          geofenceId: null,
          sourceLocationEventId: null,
          observedFrom: null,
          observedBefore: null,
        },
        sort: { sortBy: 'observedAt', sortOrder: 'desc', tieBreaker: 'id' },
      });
    });

    it('publishes exactly the eight documented fields', async () => {
      const response = await list().expect(200);
      const body = response.body as ListBody;

      expect(Object.keys(body.data[0]).sort()).toEqual([
        'createdAt',
        'geofenceId',
        'id',
        'observedAt',
        'sourceLocationEventId',
        'tenantId',
        'trackedDeviceId',
        'transition',
      ]);
    });

    it('returns 200 with an empty collection for a tenant with no alerts', async () => {
      mockPrisma.alertEvent.findMany.mockResolvedValue([]);
      mockPrisma.alertEvent.count.mockResolvedValue(0);

      const response = await list().expect(200);
      const body = response.body as ListBody;

      expect(body.data).toEqual([]);
      expect(body.meta).toMatchObject({ total: 0, count: 0, totalPages: 0 });
    });

    it('returns 200 with an empty collection past the last page', async () => {
      mockPrisma.alertEvent.findMany.mockResolvedValue([]);
      mockPrisma.alertEvent.count.mockResolvedValue(1);

      const response = await list('?page=50').expect(200);
      const body = response.body as ListBody;

      expect(body.data).toEqual([]);
      expect(body.meta).toMatchObject({ total: 1, count: 0, page: 50 });
    });

    it('accepts every documented filter together', async () => {
      await list(
        `?transition=EXIT&trackedDeviceId=${DEVICE_ID}&geofenceId=${GEOFENCE_ID}` +
          `&sourceLocationEventId=${EVENT_ID}` +
          `&observedFrom=2026-09-09T06:00:00.000Z` +
          `&observedBefore=2026-09-09T07:00:00.000Z&page=2&limit=5`,
      ).expect(200);

      const [args] = mockPrisma.alertEvent.findMany.mock.calls[0] as [
        { where: Record<string, unknown>; skip: number; take: number },
      ];
      expect(args.where).toEqual({
        tenantId: AUTH_TENANT,
        transition: 'EXIT',
        trackedDeviceId: DEVICE_ID,
        geofenceId: GEOFENCE_ID,
        sourceLocationEventId: EVENT_ID,
        observedAt: {
          gte: new Date('2026-09-09T06:00:00.000Z'),
          lt: new Date('2026-09-09T07:00:00.000Z'),
        },
      });
      expect(args.skip).toBe(5);
      expect(args.take).toBe(5);
    });

    it('rejects an invalid transition with the validation envelope', async () => {
      const response = await list('?transition=DWELL').expect(400);
      const body = response.body as ErrorBody;

      expect(body).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
        path: '/api/v1/alert-events?transition=DWELL',
      });
      expect(mockPrisma.alertEvent.findMany).not.toHaveBeenCalled();
    });

    it('rejects an over-maximum limit rather than clamping it', async () => {
      await list('?limit=101').expect(400);
      expect(mockPrisma.alertEvent.findMany).not.toHaveBeenCalled();
    });

    it('rejects malformed pagination', async () => {
      for (const queryString of [
        '?page=0',
        '?page=-1',
        '?page=1.5',
        '?page=abc',
        '?page=1&page=2',
        '?limit=0',
        '?limit=abc',
      ]) {
        await list(queryString).expect(400);
      }
      expect(mockPrisma.alertEvent.findMany).not.toHaveBeenCalled();
    });

    it('rejects an invalid timestamp', async () => {
      await list('?observedFrom=yesterday').expect(400);
      await list('?observedFrom=2026-09-09T06:00:00').expect(400);
      expect(mockPrisma.alertEvent.findMany).not.toHaveBeenCalled();
    });

    it('rejects a reversed observation window', async () => {
      await list(
        '?observedFrom=2026-09-09T07:00:00.000Z&observedBefore=2026-09-09T06:00:00.000Z',
      ).expect(400);
      expect(mockPrisma.alertEvent.findMany).not.toHaveBeenCalled();
    });

    it('rejects a filter value that tries to widen the query', async () => {
      for (const value of [
        "' OR 1=1 --",
        `${GEOFENCE_ID}' OR '1'='1`,
        '%',
        '*',
      ]) {
        await list(`?geofenceId=${encodeURIComponent(value)}`).expect(400);
      }
      expect(mockPrisma.alertEvent.findMany).not.toHaveBeenCalled();
    });

    it('rejects an arbitrary sort or selection parameter', async () => {
      for (const queryString of [
        '?sortBy=createdAt',
        '?sortOrder=asc',
        '?orderBy=id',
        '?select=tenantId',
        '?include=geofence',
        '?search=warehouse',
      ]) {
        await list(queryString).expect(400);
      }
      expect(mockPrisma.alertEvent.findMany).not.toHaveBeenCalled();
    });
  });

  describe('detail contract', () => {
    it('returns 200 with the public representation', async () => {
      const response = await detail(ALERT_ID).expect(200);
      expect(response.body).toEqual(publicAlert);
    });

    it('returns the same representation the list returns', async () => {
      const listed = (await list().expect(200)).body as ListBody;
      const single = (await detail(ALERT_ID).expect(200)).body as unknown;

      expect(single).toEqual(listed.data[0]);
    });

    it('rejects a malformed id with 400 naming the resource', async () => {
      const response = await detail('not-a-cuid').expect(400);
      const body = response.body as ErrorBody;

      expect(body.message).toBe('Invalid alert event id format');
      expect(mockPrisma.alertEvent.findFirst).not.toHaveBeenCalled();
    });

    it('returns 404 for an id the tenant does not own', async () => {
      mockPrisma.alertEvent.findFirst.mockResolvedValue(null);

      const response = await detail(ALERT_ID).expect(404);
      const body = response.body as ErrorBody;

      expect(body).toMatchObject({ statusCode: 404, error: 'Not Found' });
    });

    it('answers a foreign alert exactly as it answers a missing one', async () => {
      mockPrisma.alertEvent.findFirst.mockResolvedValue(null);
      const foreign = await detail(ALERT_ID).expect(404);

      mockPrisma.alertEvent.findFirst.mockResolvedValue(null);
      const missing = await detail('cmissingaaaaaaaaaaaaaaaaa').expect(404);

      const foreignBody = foreign.body as ErrorBody;
      const missingBody = missing.body as ErrorBody;

      expect(foreignBody.statusCode).toBe(missingBody.statusCode);
      expect(foreignBody.error).toBe(missingBody.error);
      // Only the id differs, and the id is the one the caller already supplied.
      expect(String(foreignBody.message).replace(ALERT_ID, 'ID')).toBe(
        String(missingBody.message).replace('cmissingaaaaaaaaaaaaaaaaa', 'ID'),
      );
    });

    it('leaks nothing about another tenant in the not-found body', async () => {
      mockPrisma.alertEvent.findFirst.mockResolvedValue(null);

      const response = await detail(ALERT_ID).expect(404);
      const serialized = JSON.stringify(response.body);

      expect(serialized).not.toContain(OTHER_TENANT);
      expect(serialized).not.toContain(AUTH_TENANT);
      expect(serialized).not.toContain('AlertEvent');
      expect(serialized).not.toContain('SELECT');
    });
  });

  describe('read-only surface', () => {
    it('exposes no write method on the collection', async () => {
      await request(server)
        .post('/api/v1/alert-events')
        .set('Authorization', authHeader)
        .send({ transition: 'ENTER' })
        .expect(404);

      await request(server)
        .delete('/api/v1/alert-events')
        .set('Authorization', authHeader)
        .expect(404);

      expectNoWrites();
    });

    it('exposes no write method on a single alert', async () => {
      for (const method of ['post', 'put', 'patch', 'delete'] as const) {
        await request(server)
          [method](`/api/v1/alert-events/${ALERT_ID}`)
          .set('Authorization', authHeader)
          .send({ status: 'ACKNOWLEDGED' })
          .expect(404);
      }

      expectNoWrites();
    });

    it('exposes no acknowledgement or resolution sub-route', async () => {
      for (const path of [
        `/api/v1/alert-events/${ALERT_ID}/acknowledge`,
        `/api/v1/alert-events/${ALERT_ID}/resolve`,
        `/api/v1/alert-events/${ALERT_ID}/dismiss`,
        '/api/v1/alert-events/summary',
      ]) {
        const response = await request(server)
          .post(path)
          .set('Authorization', authHeader)
          .expect(404);
        expect((response.body as ErrorBody).statusCode).toBe(404);
      }

      expectNoWrites();
    });

    it('writes nothing while serving a list and a detail request', async () => {
      await list().expect(200);
      await detail(ALERT_ID).expect(200);
      expectNoWrites();
    });
  });
});
