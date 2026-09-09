import type { Server } from 'http';

import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../app.module';
import { setupApp } from '../app.setup';
import { PrismaService } from '../prisma/prisma.service';

/**
 * HTTP-level contract tests for the GF-5 evaluation endpoint. A real Nest
 * application is booted with the production setupApp() configuration and a
 * mocked Prisma layer, so these prove routing, identifier validation, the
 * authentication guard, the status contract, the response shape and the error
 * envelope without a database.
 *
 * The spatial predicate is proven separately, against real PostgreSQL/PostGIS,
 * in test/integration/geofence-evaluation.integration-spec.ts. Nothing here
 * asserts containment: the query boundary is mocked, so a passing test says only
 * that whatever the database decided is transported and serialized correctly.
 */

const AUTH_TENANT = 'ctenantaaaaaaaaaaaaaaaaaa';
const AUTH_USER = 'cuseraaaaaaaaaaaaaaaaaaaaa';
const AUTH_MEMBERSHIP = 'cmembaaaaaaaaaaaaaaaaaaaaa';
const OTHER_TENANT = 'ctenantbbbbbbbbbbbbbbbbbb';
const DEVICE_ID = 'cdeviceaaaaaaaaaaaaaaaaaa';
const EVENT_ID = 'ceventaaaaaaaaaaaaaaaaaaa';
const NEAR_GEOFENCE = 'cgeoaaaaaaaaaaaaaaaaaaaaa';
const FAR_GEOFENCE = 'cgeobbbbbbbbbbbbbbbbbbbbb';

const OBSERVED_AT = '2026-09-09T06:00:00.000Z';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
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

const storedEvent = {
  id: EVENT_ID,
  trackedDeviceId: DEVICE_ID,
  observedAt: new Date(OBSERVED_AT),
  latitude: 30.2672,
  longitude: -97.7431,
};

const matchRow = (overrides: Record<string, unknown> = {}) => ({
  geofenceId: NEAR_GEOFENCE,
  name: 'Warehouse Zone',
  latitude: 30.2672,
  longitude: -97.7431,
  radiusMeters: 500,
  distanceMeters: 0,
  ...overrides,
});

describe('Geofence evaluation (HTTP)', () => {
  let app: INestApplication;
  let server: Server;
  let authHeader: string;

  const mockPrisma = {
    membership: { findFirst: jest.fn() },
    locationEvent: { findFirst: jest.fn() },
    $queryRaw: jest.fn(),
  };

  const evaluate = (id: string = EVENT_ID) =>
    request(server)
      .get(`/api/v1/location-events/${id}/geofence-evaluation`)
      .set('Authorization', authHeader);

  /** The parameterized statement the service handed to Prisma. */
  const statement = (): { text: string; values: unknown[] } => {
    const [[sql]] = mockPrisma.$queryRaw.mock.calls as Array<
      [{ text: string; values: unknown[] }]
    >;
    return sql;
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
    mockPrisma.locationEvent.findFirst.mockResolvedValue(storedEvent);
    mockPrisma.$queryRaw.mockResolvedValue([]);
  });

  describe('authentication', () => {
    it('rejects an anonymous request with 401', async () => {
      await request(server)
        .get(`/api/v1/location-events/${EVENT_ID}/geofence-evaluation`)
        .expect(401);
      expect(mockPrisma.locationEvent.findFirst).not.toHaveBeenCalled();
    });

    it('rejects a malformed bearer token with 401', async () => {
      await request(server)
        .get(`/api/v1/location-events/${EVENT_ID}/geofence-evaluation`)
        .set('Authorization', 'Bearer not-a-real-token')
        .expect(401);
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('rejects an expired token with 401', async () => {
      const jwt = app.get(JwtService, { strict: false });
      const expired = await jwt.signAsync(
        { sub: AUTH_USER, tid: AUTH_TENANT, mid: AUTH_MEMBERSHIP },
        { expiresIn: -10 },
      );

      await request(server)
        .get(`/api/v1/location-events/${EVENT_ID}/geofence-evaluation`)
        .set('Authorization', `Bearer ${expired}`)
        .expect(401);
    });

    it('rejects a token whose membership no longer exists with 401', async () => {
      mockPrisma.membership.findFirst.mockResolvedValue(null);

      await evaluate().expect(401);
      expect(mockPrisma.locationEvent.findFirst).not.toHaveBeenCalled();
    });

    it('is not exposed without the /api/v1 prefix', async () => {
      await request(server)
        .get(`/location-events/${EVENT_ID}/geofence-evaluation`)
        .set('Authorization', authHeader)
        .expect(404);
    });
  });

  describe('tenant derivation', () => {
    it('scopes the event lookup to the tenant in the verified token', async () => {
      await evaluate().expect(200);

      expect(mockPrisma.locationEvent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: EVENT_ID, tenantId: AUTH_TENANT },
        }),
      );
    });

    it('ignores a tenantId supplied as a query parameter', async () => {
      await request(server)
        .get(
          `/api/v1/location-events/${EVENT_ID}/geofence-evaluation?tenantId=${OTHER_TENANT}`,
        )
        .set('Authorization', authHeader)
        .expect(200);

      expect(mockPrisma.locationEvent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: EVENT_ID, tenantId: AUTH_TENANT },
        }),
      );
      expect(statement().values).not.toContain(OTHER_TENANT);
    });

    it('binds the authenticated tenant into the spatial query as a parameter', async () => {
      await evaluate().expect(200);

      const { text, values } = statement();

      // Tenant and event id reach the database as bound values, never as
      // statement text.
      expect(values).toContain(AUTH_TENANT);
      expect(values).toContain(EVENT_ID);
      expect(text).not.toContain(AUTH_TENANT);
      expect(text).not.toContain(EVENT_ID);
      expect(text).toContain('$1');
    });
  });

  describe('successful evaluation', () => {
    it('returns the stored observation and an empty result with 200', async () => {
      const res = await evaluate().expect(200);
      const body = res.body as EvaluationBody;

      expect(body).toEqual({
        locationEventId: EVENT_ID,
        trackedDeviceId: DEVICE_ID,
        observedAt: OBSERVED_AT,
        latitude: 30.2672,
        longitude: -97.7431,
        matches: [],
        matchCount: 0,
      });
    });

    it('returns matches in the order the database produced', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        matchRow({ geofenceId: NEAR_GEOFENCE, distanceMeters: 12.3456 }),
        matchRow({
          geofenceId: FAR_GEOFENCE,
          name: 'Yard',
          distanceMeters: 480.5,
          radiusMeters: 500,
        }),
      ]);

      const res = await evaluate().expect(200);
      const body = res.body as EvaluationBody;

      expect(body.matches.map((match) => match.geofenceId)).toEqual([
        NEAR_GEOFENCE,
        FAR_GEOFENCE,
      ]);
      expect(body.matchCount).toBe(2);
    });

    it('serializes distance with the documented millimeter rounding', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        matchRow({ distanceMeters: 12.3456789 }),
      ]);

      const res = await evaluate().expect(200);

      expect((res.body as EvaluationBody).matches[0].distanceMeters).toBe(
        12.346,
      );
    });

    it('never returns the derived geography columns or foreign tenant data', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([matchRow()]);

      const res = await evaluate().expect(200);
      const serialized = JSON.stringify(res.body);

      expect(serialized).not.toContain('observedPoint');
      expect(serialized).not.toContain('centerPoint');
      expect(serialized).not.toContain('tenantId');
      expect(serialized).not.toContain(OTHER_TENANT);
    });

    it('returns no request-time-dependent field', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([matchRow()]);

      const first = await evaluate().expect(200);
      const second = await evaluate().expect(200);

      expect(JSON.stringify(first.body)).toBe(JSON.stringify(second.body));
    });

    it('accepts no coordinate, radius or ordering input', async () => {
      // Unknown query parameters are ignored exactly as they are on the other
      // routes without a query DTO (for example GET /api/v1/geofences/:id);
      // crucially, none of them reaches the evaluation.
      await request(server)
        .get(
          `/api/v1/location-events/${EVENT_ID}/geofence-evaluation` +
            '?latitude=0&longitude=0&radiusMeters=99999&sortOrder=desc&active=false',
        )
        .set('Authorization', authHeader)
        .expect(200);

      expect(statement().values).toEqual([
        AUTH_TENANT,
        expect.any(Number),
        EVENT_ID,
        AUTH_TENANT,
      ]);
    });
  });

  describe('identifier validation', () => {
    it.each([
      ['a non-cuid identifier', 'not-a-cuid'],
      ['an uppercase cuid', 'CEVENTAAAAAAAAAAAAAAAAAAA'],
      ['a truncated cuid', 'cevent'],
      ['a numeric identifier', '12345'],
      ['a SQL fragment', "c'%20OR%201%3D1--"],
    ])('rejects %s with 400', async (_label, id) => {
      const res = await evaluate(id).expect(400);

      expect((res.body as ErrorBody).message).toBe(
        'Invalid location event id format',
      );
      expect(mockPrisma.locationEvent.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('still reports a malformed geofence id as a geofence error', async () => {
      // The shared pipe gained a resource label for this endpoint; the existing
      // geofence contract must be untouched by that.
      const res = await request(server)
        .get('/api/v1/geofences/not-a-cuid')
        .set('Authorization', authHeader)
        .expect(400);

      expect((res.body as ErrorBody).message).toBe(
        'Invalid geofence id format',
      );
    });
  });

  describe('not-found contract', () => {
    it('returns 404 when the tenant owns no event with that id', async () => {
      mockPrisma.locationEvent.findFirst.mockResolvedValue(null);

      const res = await evaluate().expect(404);
      const body = res.body as ErrorBody;

      expect(body.error).toBe('Not Found');
      expect(body.message).toBe(`Location event with id ${EVENT_ID} not found`);
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('is indistinguishable from a cross-tenant event', async () => {
      // Both cases are the same database answer — a tenant-scoped lookup that
      // resolves nothing — so the responses cannot differ.
      mockPrisma.locationEvent.findFirst.mockResolvedValue(null);
      const missing = await evaluate().expect(404);

      mockPrisma.locationEvent.findFirst.mockResolvedValue(null);
      const foreign = await evaluate().expect(404);

      expect(missing.body).toMatchObject({
        statusCode: (foreign.body as ErrorBody).statusCode,
        error: (foreign.body as ErrorBody).error,
        message: (foreign.body as ErrorBody).message,
      });
    });

    it('does not treat "outside every geofence" as not found', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const res = await evaluate().expect(200);

      expect((res.body as EvaluationBody).matches).toEqual([]);
      expect((res.body as EvaluationBody).matchCount).toBe(0);
    });
  });

  describe('error hygiene', () => {
    it('does not leak internal detail when the event lookup fails', async () => {
      mockPrisma.locationEvent.findFirst.mockRejectedValue(
        new Error('secret failure at /var/secret/dev.db'),
      );

      const res = await evaluate().expect(500);
      const body = res.body as ErrorBody;

      expect(body.message).toBe('Internal server error');
      expect(JSON.stringify(body)).not.toContain('secret');
    });

    it('does not leak SQL when the spatial query fails', async () => {
      mockPrisma.$queryRaw.mockRejectedValue(
        new Error(
          'ERROR: function st_dwithin(unknown) does not exist at "Geofence"."centerPoint"',
        ),
      );

      const res = await evaluate().expect(500);
      const body = res.body as ErrorBody;

      expect(body).toEqual(
        expect.objectContaining({
          statusCode: 500,
          error: 'Internal Server Error',
          message: 'Internal server error',
          path: `/api/v1/location-events/${EVENT_ID}/geofence-evaluation`,
        }),
      );
      // The envelope carries the request path, which legitimately names the
      // route, so the leak check targets everything the server chose to say.
      const { statusCode, error, message } = body;
      expect(JSON.stringify({ statusCode, error, message })).not.toMatch(
        /st_dwithin|centerpoint|geofence|does not exist/i,
      );
    });
  });

  describe('method surface', () => {
    it.each(['post', 'patch', 'put', 'delete'] as const)(
      'exposes no %s route for the evaluation path',
      async (method) => {
        await request(server)
          [method](`/api/v1/location-events/${EVENT_ID}/geofence-evaluation`)
          .set('Authorization', authHeader)
          .expect(404);
      },
    );
  });
});
