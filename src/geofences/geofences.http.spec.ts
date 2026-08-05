import type { Server } from 'http';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../app.module';
import { setupApp } from '../app.setup';
import { PrismaService } from '../prisma/prisma.service';

/**
 * HTTP-level regression tests. A real Nest application is booted with the same
 * setupApp() configuration used in production, but PrismaService is replaced by
 * an in-memory mock so no database is required. These tests prove routing, the
 * global validation behavior, identifier handling, and the error contract.
 */

const VALID_CUID = 'cjld2cjxh0000qzrmn831i7rn';

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

  const mockPrisma = {
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
    geofence: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
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
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockResolvedValue([[sampleGeofence], 1]);
    mockPrisma.geofence.create.mockResolvedValue(sampleGeofence);
    mockPrisma.geofence.findUnique.mockResolvedValue(sampleGeofence);
  });

  describe('routing', () => {
    it('exposes geofences under the /api/v1 prefix', async () => {
      await request(server).get('/api/v1/geofences').expect(200);
    });

    it('does not expose geofences without the prefix', async () => {
      await request(server).get('/geofences').expect(404);
    });

    it('keeps /health unversioned', async () => {
      const res = await request(server).get('/health').expect(200);
      expect((res.body as GeofenceBody).status).toBe('ok');
    });

    it('keeps /status unversioned', async () => {
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
        .send({ ...validCreateBody, hacker: true })
        .expect(400);
      expect((res.body as ErrorBody).message).toEqual(
        expect.arrayContaining([expect.stringContaining('hacker')]),
      );
    });

    it('creates a geofence for a valid payload', async () => {
      const res = await request(server)
        .post('/api/v1/geofences')
        .send(validCreateBody)
        .expect(201);
      expect((res.body as GeofenceBody).id).toBe(VALID_CUID);
    });

    it('rejects out-of-range latitude and excessive radius', async () => {
      await request(server)
        .post('/api/v1/geofences')
        .send({ ...validCreateBody, latitude: 100 })
        .expect(400);
      await request(server)
        .post('/api/v1/geofences')
        .send({ ...validCreateBody, radiusMeters: 0 })
        .expect(400);
      await request(server)
        .post('/api/v1/geofences')
        .send({ ...validCreateBody, radiusMeters: 999999 })
        .expect(400);
    });

    it('accepts the maximum pagination limit but rejects above it', async () => {
      await request(server).get('/api/v1/geofences?limit=100').expect(200);
      await request(server).get('/api/v1/geofences?limit=101').expect(400);
    });

    it('rejects zero and malformed pagination values', async () => {
      await request(server).get('/api/v1/geofences?limit=0').expect(400);
      await request(server).get('/api/v1/geofences?limit=abc').expect(400);
    });
  });

  describe('identifier handling', () => {
    it('rejects a malformed id with 400', async () => {
      const res = await request(server)
        .get('/api/v1/geofences/not-a-cuid')
        .expect(400);
      expect((res.body as ErrorBody).message).toBe(
        'Invalid geofence id format',
      );
    });

    it('returns 404 for a valid but unknown id', async () => {
      mockPrisma.geofence.findUnique.mockResolvedValue(null);
      const res = await request(server)
        .get(`/api/v1/geofences/${VALID_CUID}`)
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
        .send({})
        .expect(400);
    });

    it('rejects an update body containing only unknown fields', async () => {
      await request(server)
        .patch(`/api/v1/geofences/${VALID_CUID}`)
        .send({ hacker: true })
        .expect(400);
    });

    it('rejects null instead of passing it to Prisma', async () => {
      await request(server)
        .patch(`/api/v1/geofences/${VALID_CUID}`)
        .send({ name: null })
        .expect(400);
      expect(mockPrisma.geofence.update).not.toHaveBeenCalled();
    });
  });

  describe('error contract', () => {
    it('returns a stable validation error shape', async () => {
      const res = await request(server)
        .post('/api/v1/geofences')
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
      const res = await request(server).get('/api/v1/geofences').expect(500);
      const body = res.body as ErrorBody;
      expect(body.message).toBe('Internal server error');
      expect(JSON.stringify(body)).not.toContain('secret');
      expect(JSON.stringify(body)).not.toContain('/var/secret');
    });
  });
});
