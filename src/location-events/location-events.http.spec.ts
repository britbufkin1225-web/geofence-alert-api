import type { Server } from 'http';

import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../app.module';
import { setupApp } from '../app.setup';
import { PrismaService } from '../prisma/prisma.service';

/**
 * HTTP-level contract tests for GF-4 ingestion. A real Nest application is
 * booted with the production setupApp() configuration and a mocked Prisma layer,
 * so these prove routing, the global validation pipe, the authentication guard,
 * the 201/200/404/409 status contract and the error shape without a database.
 *
 * Database-backed tenant isolation, real idempotency races and spatial storage
 * are proven separately in
 * test/integration/location-event-ingestion.integration-spec.ts.
 */

const AUTH_TENANT = 'ctenantaaaaaaaaaaaaaaaaaa';
const AUTH_USER = 'cuseraaaaaaaaaaaaaaaaaaaaa';
const AUTH_MEMBERSHIP = 'cmembaaaaaaaaaaaaaaaaaaaaa';
const OTHER_TENANT = 'ctenantbbbbbbbbbbbbbbbbbb';
const DEVICE_ID = 'cdeviceaaaaaaaaaaaaaaaaaa';
const EVENT_ID = 'ceventaaaaaaaaaaaaaaaaaaa';

const OBSERVED_AT = '2026-09-09T06:00:00.000Z';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
}

interface TransitionBody {
  geofenceId: string;
  name: string;
  radiusMeters: number;
  distanceMeters: number;
  state: string;
  transition: string;
  stateAdvanced: boolean;
}

interface EventBody {
  id: string;
  tenantId: string;
  deviceKey: string;
  replayed: boolean;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  observedAt: string;
  receivedAt: string;
  geofenceTransitions: TransitionBody[];
}

const activeDevice = { id: DEVICE_ID, deviceKey: 'device-001', isActive: true };

const storedEvent = {
  id: EVENT_ID,
  tenantId: AUTH_TENANT,
  trackedDeviceId: DEVICE_ID,
  eventKey: 'evt-001',
  observedAt: new Date(OBSERVED_AT),
  receivedAt: new Date('2026-09-09T06:00:02.000Z'),
  latitude: 30.2672,
  longitude: -97.7431,
  accuracyMeters: 8.5,
};

const validBody = {
  deviceKey: 'device-001',
  eventKey: 'evt-001',
  observedAt: OBSERVED_AT,
  latitude: 30.2672,
  longitude: -97.7431,
  accuracyMeters: 8.5,
};

/** A valid body with the named properties omitted, for required-field cases. */
const withoutFields = (...fields: Array<keyof typeof validBody>) => {
  const body: Partial<typeof validBody> = { ...validBody };
  for (const field of fields) {
    delete body[field];
  }
  return body;
};

describe('Location event ingestion (HTTP)', () => {
  let app: INestApplication;
  let server: Server;
  let authHeader: string;

  const mockPrisma = {
    membership: { findFirst: jest.fn() },
    trackedDevice: { findUnique: jest.fn(), create: jest.fn() },
    locationEvent: { findUnique: jest.fn(), create: jest.fn() },
    // GF-6 transition detection runs inside ingestion and reaches the database
    // through these two. The spatial and transition semantics are proven against
    // real PostgreSQL/PostGIS in the integration suite; mocking them here would
    // only assert that the mock returns what it was told to.
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };

  const post = (body: unknown) =>
    request(server)
      .post('/api/v1/location-events')
      .set('Authorization', authHeader)
      .send(body as object);

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
    mockPrisma.trackedDevice.findUnique.mockResolvedValue(activeDevice);
    mockPrisma.locationEvent.findUnique.mockResolvedValue(null);
    mockPrisma.locationEvent.create.mockResolvedValue(storedEvent);
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.$transaction.mockImplementation(
      (run: (tx: typeof mockPrisma) => unknown) => run(mockPrisma),
    );
  });

  describe('authentication', () => {
    it('rejects an anonymous submission with 401', async () => {
      await request(server)
        .post('/api/v1/location-events')
        .send(validBody)
        .expect(401);
      expect(mockPrisma.locationEvent.create).not.toHaveBeenCalled();
    });

    it('rejects a malformed bearer token with 401', async () => {
      await request(server)
        .post('/api/v1/location-events')
        .set('Authorization', 'Bearer not-a-real-token')
        .send(validBody)
        .expect(401);
    });

    it('rejects an expired token with 401', async () => {
      const jwt = app.get(JwtService, { strict: false });
      const expired = await jwt.signAsync(
        { sub: AUTH_USER, tid: AUTH_TENANT, mid: AUTH_MEMBERSHIP },
        { expiresIn: -10 },
      );

      await request(server)
        .post('/api/v1/location-events')
        .set('Authorization', `Bearer ${expired}`)
        .send(validBody)
        .expect(401);
    });

    it('rejects a token whose membership no longer exists with 401', async () => {
      mockPrisma.membership.findFirst.mockResolvedValue(null);

      await post(validBody).expect(401);
      expect(mockPrisma.trackedDevice.findUnique).not.toHaveBeenCalled();
    });

    it('is not exposed without the /api/v1 prefix', async () => {
      await request(server)
        .post('/location-events')
        .send(validBody)
        .expect(404);
    });
  });

  describe('tenant derivation', () => {
    it('scopes the device lookup to the tenant in the verified token', async () => {
      await post(validBody).expect(201);

      expect(mockPrisma.trackedDevice.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenantId_deviceKey: {
              tenantId: AUTH_TENANT,
              deviceKey: 'device-001',
            },
          },
        }),
      );
    });

    it('rejects a client-supplied tenantId instead of honoring it', async () => {
      const res = await post({ ...validBody, tenantId: OTHER_TENANT }).expect(
        400,
      );

      expect((res.body as ErrorBody).message).toEqual(
        expect.arrayContaining([expect.stringContaining('tenantId')]),
      );
      expect(mockPrisma.locationEvent.create).not.toHaveBeenCalled();
    });

    it.each([
      ['id', { id: 'cforgedaaaaaaaaaaaaaaaaaa' }],
      ['trackedDeviceId', { trackedDeviceId: 'cotheraaaaaaaaaaaaaaaaaaa' }],
      ['receivedAt', { receivedAt: '1999-01-01T00:00:00.000Z' }],
      ['observedPoint', { observedPoint: 'POINT(0 0)' }],
      ['createdAt', { createdAt: '1999-01-01T00:00:00.000Z' }],
      // Nested relation objects, the other shape Prisma would accept.
      ['tenant', { tenant: { id: OTHER_TENANT } }],
      ['trackedDevice', { trackedDevice: { id: DEVICE_ID } }],
    ])(
      'rejects a mass-assignment attempt on %s',
      async (property, override) => {
        const res = await post({ ...validBody, ...override }).expect(400);

        expect((res.body as ErrorBody).message).toEqual(
          expect.arrayContaining([expect.stringContaining(property)]),
        );
        expect(mockPrisma.locationEvent.create).not.toHaveBeenCalled();
      },
    );
  });

  describe('successful ingestion', () => {
    it('returns 201 with the stored event and replayed=false', async () => {
      const res = await post(validBody).expect(201);
      const body = res.body as EventBody;

      expect(body.id).toBe(EVENT_ID);
      expect(body.tenantId).toBe(AUTH_TENANT);
      expect(body.deviceKey).toBe('device-001');
      expect(body.replayed).toBe(false);
      expect(body.accuracyMeters).toBe(8.5);
      expect(body.observedAt).toBe(OBSERVED_AT);
      expect(body.receivedAt).toBe('2026-09-09T06:00:02.000Z');
    });

    it('never returns the derived geography column', async () => {
      const res = await post(validBody).expect(201);
      expect(res.body).not.toHaveProperty('observedPoint');
    });

    it.each([
      ['minimum latitude', { latitude: -90 }],
      ['maximum latitude', { latitude: 90 }],
      ['minimum longitude', { longitude: -180 }],
      ['maximum longitude', { longitude: 180 }],
      ['null island', { latitude: 0, longitude: 0 }],
      ['zero accuracy', { accuracyMeters: 0 }],
      ['maximum accuracy', { accuracyMeters: 100000 }],
    ])('accepts the %s boundary', async (_label, override) => {
      await post({ ...validBody, ...override }).expect(201);
    });

    it('accepts an instant expressed with a numeric offset', async () => {
      await post({
        ...validBody,
        observedAt: '2026-09-09T08:00:00.000+02:00',
      }).expect(201);

      const [[call]] = mockPrisma.locationEvent.create.mock.calls as Array<
        [{ data: { observedAt: Date } }]
      >;
      expect(call.data.observedAt.toISOString()).toBe(OBSERVED_AT);
    });

    it('trims surrounding whitespace on the identifiers', async () => {
      await post({
        ...validBody,
        deviceKey: '  device-001  ',
        eventKey: '  evt-001  ',
      }).expect(201);

      const [[call]] = mockPrisma.locationEvent.create.mock.calls as Array<
        [{ data: { eventKey: string } }]
      >;
      expect(call.data.eventKey).toBe('evt-001');
    });
  });

  describe('geofence transition contract (GF-6)', () => {
    /**
     * The database decides containment, ordering and advancement; these rows
     * stand in for what it returned. Nothing here asserts spatial behavior —
     * that is proven against real PostGIS in
     * test/integration/geofence-transition.integration-spec.ts.
     */
    const advancedRow = {
      geofenceId: 'cgeoaaaaaaaaaaaaaaaaaaaaa',
      name: 'Warehouse Zone',
      radiusMeters: 250,
      distanceMeters: 12.3456789,
      state: 'INSIDE',
      advancedTransition: 'ENTER',
    };

    it('returns an empty transition array when no geofence is applicable', async () => {
      const res = await post(validBody).expect(201);
      expect((res.body as EventBody).geofenceTransitions).toEqual([]);
    });

    it('serializes the transition contract beside the stored event', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([advancedRow]);

      const res = await post(validBody).expect(201);
      const body = res.body as EventBody;

      // Every pre-GF-6 field keeps its meaning: the array is purely additive.
      expect(body.id).toBe(EVENT_ID);
      expect(body.replayed).toBe(false);
      expect(body.geofenceTransitions).toEqual([
        {
          geofenceId: 'cgeoaaaaaaaaaaaaaaaaaaaaa',
          name: 'Warehouse Zone',
          radiusMeters: 250,
          distanceMeters: 12.346,
          state: 'INSIDE',
          transition: 'ENTER',
          stateAdvanced: true,
        },
      ]);
    });

    it('reports a non-advancing observation without claiming a crossing', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        { ...advancedRow, state: 'OUTSIDE', advancedTransition: null },
      ]);
      mockPrisma.$queryRaw.mockResolvedValueOnce([]);

      const res = await post(validBody).expect(201);
      const [transition] = (res.body as EventBody).geofenceTransitions;

      expect(transition.stateAdvanced).toBe(false);
      expect(transition.transition).toBe('STAY_OUTSIDE');
    });

    it('never returns a geography column inside a transition', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([advancedRow]);

      const res = await post(validBody).expect(201);
      const serialized = JSON.stringify(res.body);

      expect(serialized).not.toContain('centerPoint');
      expect(serialized).not.toContain('observedPoint');
    });

    it('maps a transition-detection failure to the sanitized 500 envelope', async () => {
      mockPrisma.$transaction.mockRejectedValue(
        new Error('relation "GeofenceDeviceState" does not exist at /srv/db'),
      );

      const res = await post(validBody).expect(500);
      const body = res.body as ErrorBody;

      expect(body.message).toBe('Internal server error');
      expect(JSON.stringify(body)).not.toContain('GeofenceDeviceState');
      expect(JSON.stringify(body)).not.toContain('/srv/db');
    });

    it('does not evaluate transitions for a conflicting replay', async () => {
      mockPrisma.locationEvent.findUnique.mockResolvedValue({
        ...storedEvent,
        latitude: 1,
      });

      await post(validBody).expect(409);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('does not evaluate transitions for a device outside the tenant', async () => {
      mockPrisma.trackedDevice.findUnique.mockResolvedValue(null);

      await post(validBody).expect(404);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('does not evaluate transitions for an anonymous submission', async () => {
      await request(server)
        .post('/api/v1/location-events')
        .send(validBody)
        .expect(401);

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('device resolution', () => {
    it('returns 404 when the tenant owns no device with that key', async () => {
      mockPrisma.trackedDevice.findUnique.mockResolvedValue(null);

      const res = await post(validBody).expect(404);
      const body = res.body as ErrorBody;

      expect(body.error).toBe('Not Found');
      expect(body.message).toBe('Tracked device not found');
      expect(JSON.stringify(body)).not.toContain(OTHER_TENANT);
    });

    it('returns 409 for a device the tenant owns but has deactivated', async () => {
      mockPrisma.trackedDevice.findUnique.mockResolvedValue({
        ...activeDevice,
        isActive: false,
      });

      const res = await post(validBody).expect(409);
      expect((res.body as ErrorBody).message).toBe(
        'Tracked device is not active',
      );
      expect(mockPrisma.locationEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('idempotency contract', () => {
    it('returns 200 and replayed=true for an identical resubmission', async () => {
      mockPrisma.locationEvent.findUnique.mockResolvedValue(storedEvent);

      const res = await post(validBody).expect(200);

      expect((res.body as EventBody).replayed).toBe(true);
      expect((res.body as EventBody).id).toBe(EVENT_ID);
      expect(mockPrisma.locationEvent.create).not.toHaveBeenCalled();
    });

    it('returns 409 when the same key carries different coordinates', async () => {
      mockPrisma.locationEvent.findUnique.mockResolvedValue(storedEvent);

      const res = await post({ ...validBody, latitude: 31.5 }).expect(409);

      expect((res.body as ErrorBody).error).toBe('Conflict');
      expect((res.body as ErrorBody).message).toBe(
        'eventKey already used for a different location event',
      );
    });

    it('returns 409 when the same key carries a different timestamp', async () => {
      mockPrisma.locationEvent.findUnique.mockResolvedValue(storedEvent);

      await post({
        ...validBody,
        observedAt: '2026-09-09T05:00:00.000Z',
      }).expect(409);
    });
  });

  describe('coordinate validation', () => {
    it.each(['latitude', 'longitude', 'accuracyMeters'])(
      'rejects JSON numeric overflow in %s',
      async (field) => {
        for (const value of ['1e400', '-1e400']) {
          const body = JSON.stringify({
            ...validBody,
            [field]: 'OVERFLOW',
          }).replace('"OVERFLOW"', value);
          await request(server)
            .post('/api/v1/location-events')
            .set('Authorization', authHeader)
            .set('Content-Type', 'application/json')
            .send(body)
            .expect(400);
        }
        expect(mockPrisma.locationEvent.create).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['latitude below -90', { latitude: -90.000001 }],
      ['latitude above 90', { latitude: 90.000001 }],
      ['longitude below -180', { longitude: -180.000001 }],
      ['longitude above 180', { longitude: 180.000001 }],
      ['a numeric string latitude', { latitude: '30.2672' }],
      ['a numeric string longitude', { longitude: '-97.7431' }],
      ['a boolean latitude', { latitude: true }],
      ['an array latitude', { latitude: [30.2672] }],
      ['an object longitude', { longitude: { value: 1 } }],
      ['a null latitude', { latitude: null }],
      ['a null longitude', { longitude: null }],
    ])('rejects %s', async (_label, override) => {
      await post({ ...validBody, ...override }).expect(400);
      expect(mockPrisma.locationEvent.create).not.toHaveBeenCalled();
    });

    it('rejects a missing latitude and longitude', async () => {
      const rest = withoutFields('latitude', 'longitude');
      const res = await post(rest).expect(400);

      expect((res.body as ErrorBody).message).toEqual(
        expect.arrayContaining([
          expect.stringContaining('latitude'),
          expect.stringContaining('longitude'),
        ]),
      );
    });

    it('rejects the non-finite values JSON can smuggle through', async () => {
      // JSON has no NaN/Infinity literal, so a client that wants them must send
      // them as strings or as a raw body. Both are refused.
      await post({ ...validBody, latitude: 'NaN' }).expect(400);
      await post({ ...validBody, latitude: 'Infinity' }).expect(400);

      await request(server)
        .post('/api/v1/location-events')
        .set('Authorization', authHeader)
        .set('Content-Type', 'application/json')
        .send('{"deviceKey":"device-001","eventKey":"e","latitude":NaN}')
        .expect(400);
    });
  });

  describe('timestamp validation', () => {
    it.each([
      ['a timezone-free timestamp', '2026-09-09T06:00:00'],
      ['a date without a time', '2026-09-09'],
      ['an impossible calendar date', '2026-02-30T00:00:00.000Z'],
      ['a non-leap 29 February', '2025-02-29T00:00:00.000Z'],
      ['a malformed timestamp', 'yesterday'],
      ['an epoch millisecond value', '1789253000000'],
      ['an empty string', ''],
      ['a far-future timestamp', '2099-01-01T00:00:00.000Z'],
    ])('rejects %s', async (_label, observedAt) => {
      await post({ ...validBody, observedAt }).expect(400);
      expect(mockPrisma.locationEvent.create).not.toHaveBeenCalled();
    });

    it('rejects a missing observedAt', async () => {
      const rest = withoutFields('observedAt');
      const res = await post(rest).expect(400);

      expect((res.body as ErrorBody).message).toEqual(
        expect.arrayContaining([expect.stringContaining('observedAt')]),
      );
    });

    it('rejects a timestamp beyond the future-skew allowance', async () => {
      const beyondSkew = new Date(Date.now() + 6 * 60 * 1000).toISOString();
      await post({ ...validBody, observedAt: beyondSkew }).expect(400);
    });

    it('accepts a timestamp inside the future-skew allowance', async () => {
      const withinSkew = new Date(Date.now() + 60 * 1000).toISOString();
      await post({ ...validBody, observedAt: withinSkew }).expect(201);
    });

    it('accepts a heavily back-dated timestamp (retention deferred)', async () => {
      await post({
        ...validBody,
        observedAt: '2015-06-01T00:00:00.000Z',
      }).expect(201);
    });
  });

  describe('accuracy validation', () => {
    it.each([
      ['a negative accuracy', { accuracyMeters: -0.1 }],
      ['an accuracy beyond the ceiling', { accuracyMeters: 100000.1 }],
      ['a numeric string accuracy', { accuracyMeters: '8.5' }],
      ['a null accuracy', { accuracyMeters: null }],
    ])('rejects %s', async (_label, override) => {
      await post({ ...validBody, ...override }).expect(400);
    });

    it('rejects a missing accuracyMeters', async () => {
      const rest = withoutFields('accuracyMeters');
      const res = await post(rest).expect(400);

      expect((res.body as ErrorBody).message).toEqual(
        expect.arrayContaining([expect.stringContaining('accuracyMeters')]),
      );
    });
  });

  describe('identifier validation', () => {
    it.each([
      ['an empty deviceKey', { deviceKey: '' }],
      ['a whitespace-only deviceKey', { deviceKey: '   ' }],
      ['an empty eventKey', { eventKey: '' }],
      ['a whitespace-only eventKey', { eventKey: '\t\n ' }],
      ['an oversized deviceKey', { deviceKey: 'd'.repeat(129) }],
      ['an oversized eventKey', { eventKey: 'e'.repeat(201) }],
      ['a deviceKey with a space', { deviceKey: 'device 001' }],
      ['an eventKey with a slash', { eventKey: 'evt/001' }],
      ['a numeric deviceKey', { deviceKey: 12345 }],
      ['a null eventKey', { eventKey: null }],
    ])('rejects %s', async (_label, override) => {
      await post({ ...validBody, ...override }).expect(400);
      expect(mockPrisma.locationEvent.create).not.toHaveBeenCalled();
    });

    it('accepts the maximum-length identifiers', async () => {
      await post({
        ...validBody,
        deviceKey: 'd'.repeat(128),
        eventKey: 'e'.repeat(200),
      }).expect(201);
    });

    it('rejects a missing deviceKey and eventKey', async () => {
      const res = await post({
        observedAt: OBSERVED_AT,
        latitude: 1,
        longitude: 1,
        accuracyMeters: 1,
      }).expect(400);

      expect((res.body as ErrorBody).message).toEqual(
        expect.arrayContaining([
          expect.stringContaining('deviceKey'),
          expect.stringContaining('eventKey'),
        ]),
      );
    });
  });

  describe('body shape', () => {
    it('rejects an unknown property', async () => {
      const res = await post({ ...validBody, hacker: true }).expect(400);
      expect((res.body as ErrorBody).message).toEqual(
        expect.arrayContaining([expect.stringContaining('hacker')]),
      );
    });

    it('rejects an empty body with the stable error contract', async () => {
      const res = await post({}).expect(400);
      const body = res.body as ErrorBody;

      expect(body).toEqual(
        expect.objectContaining({
          statusCode: 400,
          error: 'Bad Request',
          path: '/api/v1/location-events',
        }),
      );
      expect(Array.isArray(body.message)).toBe(true);
      expect(typeof body.timestamp).toBe('string');
    });

    it('rejects an array body', async () => {
      await post([validBody]).expect(400);
    });
  });

  describe('error hygiene', () => {
    it('does not leak internal failure detail', async () => {
      mockPrisma.trackedDevice.findUnique.mockRejectedValue(
        new Error('secret failure at /var/secret/dev.db'),
      );

      const res = await post(validBody).expect(500);
      const body = res.body as ErrorBody;

      expect(body.message).toBe('Internal server error');
      expect(JSON.stringify(body)).not.toContain('secret');
    });
  });
});

describe('Tracked device registration (HTTP)', () => {
  let app: INestApplication;
  let server: Server;
  let authHeader: string;

  const mockPrisma = {
    membership: { findFirst: jest.fn() },
    trackedDevice: { create: jest.fn() },
  };

  const storedDevice = {
    id: DEVICE_ID,
    tenantId: AUTH_TENANT,
    deviceKey: 'device-001',
    name: 'Van 1',
    isActive: true,
    createdAt: new Date('2026-09-09T06:00:00.000Z'),
    updatedAt: new Date('2026-09-09T06:00:00.000Z'),
  };

  const validDevice = { deviceKey: 'device-001', name: 'Van 1' };

  const post = (body: unknown) =>
    request(server)
      .post('/api/v1/tracked-devices')
      .set('Authorization', authHeader)
      .send(body as object);

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
    mockPrisma.trackedDevice.create.mockResolvedValue(storedDevice);
  });

  it('rejects anonymous registration with 401', async () => {
    await request(server)
      .post('/api/v1/tracked-devices')
      .send(validDevice)
      .expect(401);
    expect(mockPrisma.trackedDevice.create).not.toHaveBeenCalled();
  });

  it('rejects registration after membership deletion before calling the service', async () => {
    mockPrisma.membership.findFirst.mockResolvedValue(null);
    await post(validDevice).expect(401);
    expect(mockPrisma.trackedDevice.create).not.toHaveBeenCalled();
  });

  it('does not report a primary-key collision as a duplicate device key', async () => {
    mockPrisma.trackedDevice.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('secret SQL constraint path', {
        code: 'P2002',
        clientVersion: 'test',
        meta: {
          modelName: 'TrackedDevice',
          driverAdapterError: {
            cause: {
              kind: 'UniqueConstraintViolation',
              constraint: { index: 'TrackedDevice_pkey' },
            },
          },
        },
      }),
    );
    const res = await post(validDevice).expect(500);
    expect((res.body as ErrorBody).message).toBe('Internal server error');
    expect(JSON.stringify(res.body)).not.toMatch(
      /secret|P2002|TrackedDevice_pkey/,
    );
  });

  it('registers a device owned by the authenticated tenant', async () => {
    const res = await post(validDevice).expect(201);

    expect(mockPrisma.trackedDevice.create).toHaveBeenCalledWith({
      data: {
        deviceKey: 'device-001',
        name: 'Van 1',
        isActive: true,
        tenant: { connect: { id: AUTH_TENANT } },
      },
    });
    expect((res.body as { tenantId: string }).tenantId).toBe(AUTH_TENANT);
  });

  it('rejects a client-supplied tenantId', async () => {
    const res = await post({ ...validDevice, tenantId: OTHER_TENANT }).expect(
      400,
    );

    expect((res.body as ErrorBody).message).toEqual(
      expect.arrayContaining([expect.stringContaining('tenantId')]),
    );
    expect(mockPrisma.trackedDevice.create).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty deviceKey', { deviceKey: '' }],
    ['a whitespace-only name', { name: '   ' }],
    ['an oversized deviceKey', { deviceKey: 'd'.repeat(129) }],
    ['an oversized name', { name: 'n'.repeat(121) }],
    ['a deviceKey with a space', { deviceKey: 'device 001' }],
    ['a non-boolean isActive', { isActive: 'yes' }],
    ['a null isActive', { isActive: null }],
    ['an unknown property', { hacker: true }],
  ])('rejects %s', async (_label, override) => {
    await post({ ...validDevice, ...override }).expect(400);
    expect(mockPrisma.trackedDevice.create).not.toHaveBeenCalled();
  });

  it('reports a duplicate key within the tenant as a 409', async () => {
    mockPrisma.trackedDevice.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: {
          modelName: 'TrackedDevice',
          driverAdapterError: {
            cause: {
              kind: 'UniqueConstraintViolation',
              constraint: { index: 'TrackedDevice_tenantId_deviceKey_key' },
            },
          },
        },
      }),
    );

    const res = await post(validDevice).expect(409);
    const body = res.body as ErrorBody;

    expect(body.message).toBe('Device key already registered');
    expect(JSON.stringify(body)).not.toContain('P2002');
    expect(JSON.stringify(body).toLowerCase()).not.toContain(
      'unique constraint',
    );
  });
});
