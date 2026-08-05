import type { Server } from 'http';

import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../app.module';
import { setupApp } from '../app.setup';
import { PrismaService } from '../prisma/prisma.service';

/**
 * HTTP-level regression tests. A real Nest application is booted with the same
 * setupApp() configuration used in production, but PrismaService is replaced by
 * an in-memory mock so no database is required. These tests prove routing, the
 * global validation behavior, identifier handling, the authentication guard,
 * and the error contract. Deeper database-backed tenant-isolation proofs live
 * in tenant-isolation.spec.ts (a real isolated SQLite database).
 */

const VALID_CUID = 'cjld2cjxh0000qzrmn831i7rn';
const AUTH_TENANT = 'ctenantaaaaaaaaaaaaaaaaaa';
const AUTH_USER = 'cuseraaaaaaaaaaaaaaaaaaaaa';
const AUTH_MEMBERSHIP = 'cmembaaaaaaaaaaaaaaaaaaaaa';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
}

interface GeofenceBody {
  id: string;
  status?: string;
}

const sampleGeofence = {
  id: VALID_CUID,
  tenantId: AUTH_TENANT,
  name: 'Warehouse Zone',
  description: null,
  latitude: 30.2672,
  longitude: -97.7431,
  radiusMeters: 100,
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const validCreateBody = {
  name: 'Warehouse Zone',
  latitude: 30.2672,
  longitude: -97.7431,
  radiusMeters: 100,
};

describe('Geofence API (HTTP)', () => {
  let app: INestApplication;
  let server: Server;
  let authHeader: string;

  const mockPrisma = {
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
    geofence: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrisma)
      .compile();

    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    server = app.getHttpServer() as Server;

    // Mint a valid token the same way the app signs one, so the global guard
    // admits these requests without needing a database-backed login.
    const jwt = app.get(JwtService, { strict: false });
    const token = await jwt.signAsync({
      sub: AUTH_USER,
      tid: AUTH_TENANT,
      mid: AUTH_MEMBERSHIP,
    });
    authHeader = `Bearer ${token}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockResolvedValue([[sampleGeofence], 1]);
    mockPrisma.geofence.create.mockResolvedValue(sampleGeofence);
    mockPrisma.geofence.findFirst.mockResolvedValue(sampleGeofence);
  });

  describe('authentication guard', () => {
    it('rejects geofence access without a bearer token (401)', async () => {
      await request(server).get('/api/v1/geofences').expect(401);
    });

    it('rejects a malformed bearer token (401)', async () => {
      await request(server)
        .get('/api/v1/geofences')
        .set('Authorization', 'Bearer not-a-real-token')
        .expect(401);
    });

    it('protects /api/v1/db/status from anonymous access (401)', async () => {
      await request(server).get('/api/v1/db/status').expect(401);
    });
  });

  describe('routing', () => {
    it('exposes geofences under the /api/v1 prefix', async () => {
      await request(server)
        .get('/api/v1/geofences')
        .set('Authorization', authHeader)
        .expect(200);
    });

    it('does not expose geofences without the prefix', async () => {
      await request(server).get('/geofences').expect(404);
    });

    it('keeps /health unversioned and public', async () => {
      const res = await request(server).get('/health').expect(200);
      expect((res.body as GeofenceBody).status).toBe('ok');
    });

    it('keeps /status unversioned and public', async () => {
      const res = await request(server).get('/status').expect(200);
      expect((res.body as GeofenceBody).status).toBe('running');
    });

    it('does not serve /health under the prefix', async () => {
      await request(server).get('/api/v1/health').expect(404);
    });
  });

  describe('validation', () => {
    it('rejects unknown properties on create', async () => {
      const res = await request(server)
        .post('/api/v1/geofences')
        .set('Authorization', authHeader)
        .send({ ...validCreateBody, hacker: true })
        .expect(400);
      expect((res.body as ErrorBody).message).toEqual(
        expect.arrayContaining([expect.stringContaining('hacker')]),
      );
    });

    it('rejects a client-supplied tenantId as an unknown property (no ownership hijack)', async () => {
      const res = await request(server)
        .post('/api/v1/geofences')
        .set('Authorization', authHeader)
        .send({ ...validCreateBody, tenantId: 'ctenantbbbbbbbbbbbbbbbbbb' })
        .expect(400);
      expect((res.body as ErrorBody).message).toEqual(
        expect.arrayContaining([expect.stringContaining('tenantId')]),
      );
      expect(mockPrisma.geofence.create).not.toHaveBeenCalled();
    });

    it('creates a geofence for a valid payload', async () => {
      const res = await request(server)
        .post('/api/v1/geofences')
        .set('Authorization', authHeader)
        .send(validCreateBody)
        .expect(201);
      expect((res.body as GeofenceBody).id).toBe(VALID_CUID);
    });

    it('rejects out-of-range latitude and excessive radius', async () => {
      await request(server)
        .post('/api/v1/geofences')
        .set('Authorization', authHeader)
        .send({ ...validCreateBody, latitude: 100 })
        .expect(400);
      await request(server)
        .post('/api/v1/geofences')
        .set('Authorization', authHeader)
        .send({ ...validCreateBody, radiusMeters: 0 })
        .expect(400);
      await request(server)
        .post('/api/v1/geofences')
        .set('Authorization', authHeader)
        .send({ ...validCreateBody, radiusMeters: 999999 })
        .expect(400);
    });

    it('accepts the maximum pagination limit but rejects above it', async () => {
      await request(server)
        .get('/api/v1/geofences?limit=100')
        .set('Authorization', authHeader)
        .expect(200);
      await request(server)
        .get('/api/v1/geofences?limit=101')
        .set('Authorization', authHeader)
        .expect(400);
    });

    it('rejects zero and malformed pagination values', async () => {
      await request(server)
        .get('/api/v1/geofences?limit=0')
        .set('Authorization', authHeader)
        .expect(400);
      await request(server)
        .get('/api/v1/geofences?limit=abc')
        .set('Authorization', authHeader)
        .expect(400);
    });
  });

  describe('identifier handling', () => {
    it('rejects a malformed id with 400', async () => {
      const res = await request(server)
        .get('/api/v1/geofences/not-a-cuid')
        .set('Authorization', authHeader)
        .expect(400);
      expect((res.body as ErrorBody).message).toBe(
        'Invalid geofence id format',
      );
    });

    it('returns 404 for a valid but unknown id', async () => {
      mockPrisma.geofence.findFirst.mockResolvedValue(null);
      const res = await request(server)
        .get(`/api/v1/geofences/${VALID_CUID}`)
        .set('Authorization', authHeader)
        .expect(404);
      const body = res.body as ErrorBody;
      expect(body.statusCode).toBe(404);
      expect(body.error).toBe('Not Found');
    });
  });

  describe('update body hardening', () => {
    it('rejects an empty update body', async () => {
      await request(server)
        .patch(`/api/v1/geofences/${VALID_CUID}`)
        .set('Authorization', authHeader)
        .send({})
        .expect(400);
    });

    it('rejects an update body containing only unknown fields', async () => {
      await request(server)
        .patch(`/api/v1/geofences/${VALID_CUID}`)
        .set('Authorization', authHeader)
        .send({ hacker: true })
        .expect(400);
    });

    it('rejects an attempt to reassign tenant ownership via PATCH', async () => {
      await request(server)
        .patch(`/api/v1/geofences/${VALID_CUID}`)
        .set('Authorization', authHeader)
        .send({ tenantId: 'ctenantbbbbbbbbbbbbbbbbbb' })
        .expect(400);
      expect(mockPrisma.geofence.update).not.toHaveBeenCalled();
    });

    it('rejects null instead of passing it to Prisma', async () => {
      await request(server)
        .patch(`/api/v1/geofences/${VALID_CUID}`)
        .set('Authorization', authHeader)
        .send({ name: null })
        .expect(400);
      expect(mockPrisma.geofence.update).not.toHaveBeenCalled();
    });
  });

  describe('error contract', () => {
    it('returns a stable validation error shape', async () => {
      const res = await request(server)
        .post('/api/v1/geofences')
        .set('Authorization', authHeader)
        .send({})
        .expect(400);
      const body = res.body as ErrorBody;
      expect(body).toEqual(
        expect.objectContaining({
          statusCode: 400,
          error: 'Bad Request',
          path: '/api/v1/geofences',
        }),
      );
      expect(typeof body.timestamp).toBe('string');
      expect(Array.isArray(body.message)).toBe(true);
    });

    it('does not leak internal error details on unexpected failures', async () => {
      mockPrisma.$transaction.mockRejectedValue(
        new Error('secret failure at /var/secret/dev.db'),
      );
      const res = await request(server)
        .get('/api/v1/geofences')
        .set('Authorization', authHeader)
        .expect(500);
      const body = res.body as ErrorBody;
      expect(body.message).toBe('Internal server error');
      expect(JSON.stringify(body)).not.toContain('secret');
      expect(JSON.stringify(body)).not.toContain('/var/secret');
    });
  });
});
