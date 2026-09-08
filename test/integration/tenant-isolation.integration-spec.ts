import type { Server } from 'http';

import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { setupApp } from '../../src/app.setup';
import { PrismaService } from '../../src/prisma/prisma.service';
import { requireDisposableDatabaseUrl, truncateAll } from './support/database';

/**
 * REAL database integration test (not a Prisma mock). It drives the HTTP API
 * end-to-end against the disposable PostgreSQL/PostGIS database that
 * `npm run test:db` provisions and migrates, then empties every table it used.
 *
 * Before GF-3 this same matrix ran against a temporary SQLite file. The
 * assertions are deliberately unchanged: the tenant boundary (IDOR/BOLA
 * mitigation) must hold identically on PostgreSQL. An authenticated user of one
 * tenant cannot read, list, search, modify or delete another tenant's
 * geofences, cannot create data owned by another tenant, and cannot reassign
 * ownership; anonymous callers are refused outright.
 */

const validGeofence = (name: string) => ({
  name,
  latitude: 30.2672,
  longitude: -97.7431,
  radiusMeters: 100,
});

function decodeIdentityClaims(
  jwt: JwtService,
  token: string,
): { sub: string; mid: string } {
  const decoded: unknown = jwt.decode(token);
  if (!decoded || typeof decoded !== 'object') {
    throw new Error('Expected a JWT object payload');
  }
  const claims = decoded as Record<string, unknown>;
  if (typeof claims.sub !== 'string' || typeof claims.mid !== 'string') {
    throw new Error('Expected JWT identity claims');
  }
  return { sub: claims.sub, mid: claims.mid };
}

interface AuthResponse {
  accessToken: string;
  tokenType: string;
  user: { id: string; email: string; createdAt: string };
  tenant: { id: string; name: string };
}

describe('Tenant isolation (real PostgreSQL/PostGIS integration)', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  let prisma: PrismaService;

  // Tenant A / User A and Tenant B / User B.
  let tokenA: string;
  let tokenB: string;
  let tenantAId: string;
  let tenantBId: string;
  let geofenceAId: string;
  let geofenceBId: string;

  const auth = (token: string) => `Bearer ${token}`;

  const register = async (
    email: string,
    password: string,
    tenantName: string,
  ) => {
    const res = await request(server)
      .post('/api/v1/auth/register')
      .send({ email, password, tenantName })
      .expect(201);
    return res.body as AuthResponse;
  };

  beforeAll(async () => {
    // Fails loudly unless DATABASE_URL points at the disposable database, so
    // the truncation below can never reach developer-owned data.
    requireDisposableDatabaseUrl();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
    jwt = app.get(JwtService, { strict: false });
    prisma = app.get(PrismaService);

    // Every integration suite shares one database; start from a known-empty
    // state rather than depending on execution order.
    await truncateAll(prisma);

    const a = await register('alice@example.com', 'password-A1', 'Tenant A');
    const b = await register('bob@example.com', 'password-B1', 'Tenant B');
    tokenA = a.accessToken;
    tokenB = b.accessToken;
    tenantAId = a.tenant.id;
    tenantBId = b.tenant.id;

    const gaRes = await request(server)
      .post('/api/v1/geofences')
      .set('Authorization', auth(tokenA))
      .send(validGeofence('Alpha Zone'))
      .expect(201);
    geofenceAId = (gaRes.body as { id: string }).id;

    const gbRes = await request(server)
      .post('/api/v1/geofences')
      .set('Authorization', auth(tokenB))
      .send(validGeofence('Alpha Zone')) // same name to prove search scoping
      .expect(201);
    geofenceBId = (gbRes.body as { id: string }).id;
  });

  afterAll(async () => {
    if (prisma) {
      await truncateAll(prisma);
    }
    if (app) {
      await app.close();
    }
  });

  it('gives A and B distinct tenants', () => {
    expect(tenantAId).not.toEqual(tenantBId);
    expect(geofenceAId).not.toEqual(geofenceBId);
  });

  describe('anonymous access is denied', () => {
    it.each([
      ['GET', '/api/v1/geofences'],
      ['GET', '/api/v1/geofences/summary'],
      ['POST', '/api/v1/geofences'],
      ['GET', '/api/v1/auth/me'],
    ])('rejects unauthenticated %s %s with 401', async (method, path) => {
      const call =
        method === 'POST'
          ? request(server).post(path).send(validGeofence('Anon'))
          : request(server).get(path);
      await call.expect(401);
    });

    it('cannot read a specific geofence without a token', async () => {
      await request(server).get(`/api/v1/geofences/${geofenceAId}`).expect(401);
    });

    it('cannot delete a geofence without a token, and it survives', async () => {
      await request(server)
        .delete(`/api/v1/geofences/${geofenceAId}`)
        .expect(401);

      await request(server)
        .get(`/api/v1/geofences/${geofenceAId}`)
        .set('Authorization', auth(tokenA))
        .expect(200);
    });
  });

  describe('listing', () => {
    it('A lists only A data', async () => {
      const res = await request(server)
        .get('/api/v1/geofences')
        .set('Authorization', auth(tokenA))
        .expect(200);
      const body = res.body as {
        data: Array<{ id: string; tenantId: string }>;
      };
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(geofenceAId);
      expect(body.data[0].tenantId).toBe(tenantAId);
    });

    it('B lists only B data', async () => {
      const res = await request(server)
        .get('/api/v1/geofences')
        .set('Authorization', auth(tokenB))
        .expect(200);
      const body = res.body as { data: Array<{ id: string }> };
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(geofenceBId);
    });
  });

  describe('cross-tenant object access → 404 (no existence disclosure)', () => {
    it('A can GET its own resource', async () => {
      await request(server)
        .get(`/api/v1/geofences/${geofenceAId}`)
        .set('Authorization', auth(tokenA))
        .expect(200);
    });

    it("A cannot GET B's resource", async () => {
      const res = await request(server)
        .get(`/api/v1/geofences/${geofenceBId}`)
        .set('Authorization', auth(tokenA))
        .expect(404);
      // No leakage of the foreign tenant id or existence details.
      expect(JSON.stringify(res.body)).not.toContain(tenantBId);
    });

    it("B cannot GET A's resource", async () => {
      await request(server)
        .get(`/api/v1/geofences/${geofenceAId}`)
        .set('Authorization', auth(tokenB))
        .expect(404);
    });

    it("A cannot PATCH B's resource and does not mutate it", async () => {
      await request(server)
        .patch(`/api/v1/geofences/${geofenceBId}`)
        .set('Authorization', auth(tokenA))
        .send({ name: 'Hijacked' })
        .expect(404);

      // Prove B's record is untouched.
      const res = await request(server)
        .get(`/api/v1/geofences/${geofenceBId}`)
        .set('Authorization', auth(tokenB))
        .expect(200);
      expect((res.body as { name: string }).name).toBe('Alpha Zone');
    });

    it("A cannot DELETE B's resource and it survives", async () => {
      await request(server)
        .delete(`/api/v1/geofences/${geofenceBId}`)
        .set('Authorization', auth(tokenA))
        .expect(404);

      await request(server)
        .get(`/api/v1/geofences/${geofenceBId}`)
        .set('Authorization', auth(tokenB))
        .expect(200);
    });
  });

  describe('search / pagination / summary cannot cross tenants', () => {
    it('search for a name shared across tenants returns only own data', async () => {
      const res = await request(server)
        .get('/api/v1/geofences?search=Alpha')
        .set('Authorization', auth(tokenA))
        .expect(200);
      const body = res.body as {
        data: Array<{ id: string }>;
        meta: { total: number };
      };
      expect(body.meta.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(geofenceAId);
    });

    it('pagination totals reflect only the caller tenant', async () => {
      const res = await request(server)
        .get('/api/v1/geofences?limit=100')
        .set('Authorization', auth(tokenA))
        .expect(200);
      expect((res.body as { meta: { total: number } }).meta.total).toBe(1);
    });

    it('summary counts only the caller tenant', async () => {
      const res = await request(server)
        .get('/api/v1/geofences/summary')
        .set('Authorization', auth(tokenA))
        .expect(200);
      expect((res.body as { total: number }).total).toBe(1);
    });
  });

  describe('ownership cannot be forged or reassigned', () => {
    it('a client-supplied tenantId on create is rejected (400), not honored', async () => {
      await request(server)
        .post('/api/v1/geofences')
        .set('Authorization', auth(tokenA))
        .send({ ...validGeofence('Forged'), tenantId: tenantBId })
        .expect(400);

      // B's list is unchanged (nothing was created under B).
      const res = await request(server)
        .get('/api/v1/geofences')
        .set('Authorization', auth(tokenB))
        .expect(200);
      expect((res.body as { data: unknown[] }).data).toHaveLength(1);
    });

    it('PATCH cannot change ownership (tenantId is rejected as unknown)', async () => {
      await request(server)
        .patch(`/api/v1/geofences/${geofenceAId}`)
        .set('Authorization', auth(tokenA))
        .send({ tenantId: tenantBId })
        .expect(400);

      const res = await request(server)
        .get(`/api/v1/geofences/${geofenceAId}`)
        .set('Authorization', auth(tokenA))
        .expect(200);
      expect((res.body as { tenantId: string }).tenantId).toBe(tenantAId);
    });
  });

  describe('authenticated identity (/auth/me)', () => {
    it('returns the correct identity and never a password hash', async () => {
      const res = await request(server)
        .get('/api/v1/auth/me')
        .set('Authorization', auth(tokenA))
        .expect(200);
      const body = res.body as Record<string, unknown>;
      expect(body.email).toBe('alice@example.com');
      expect(body.tenantId).toBe(tenantAId);
      expect(JSON.stringify(body)).not.toContain('passwordHash');
      expect(JSON.stringify(body)).not.toContain('password-A1');
    });
  });

  describe('token handling against a real signer', () => {
    it('rejects a missing token', async () => {
      await request(server).get('/api/v1/auth/me').expect(401);
    });

    it('rejects an altered (bad-signature) token', async () => {
      const tampered =
        tokenA.slice(0, -3) + (tokenA.endsWith('a') ? 'b' : 'a') + 'xy';
      await request(server)
        .get('/api/v1/auth/me')
        .set('Authorization', auth(tampered))
        .expect(401);
    });

    it('rejects an expired token', async () => {
      const expired = await jwt.signAsync(
        { sub: 'x', tid: 'y', mid: 'z' },
        { expiresIn: -10 },
      );
      await request(server)
        .get('/api/v1/auth/me')
        .set('Authorization', auth(expired))
        .expect(401);
    });

    it('rejects a correctly signed token without an expiration claim', async () => {
      const noExpiry = await jwt.signAsync(
        { sub: 'x', tid: 'y', mid: 'z' },
        { noTimestamp: true },
      );
      await request(server)
        .get('/api/v1/auth/me')
        .set('Authorization', auth(noExpiry))
        .expect(401);
    });

    it('rejects a valid signature with an inconsistent membership tuple', async () => {
      const claims = decodeIdentityClaims(jwt, tokenA);
      const forgedTuple = await jwt.signAsync({
        sub: claims.sub,
        tid: tenantBId,
        mid: claims.mid,
      });
      await request(server)
        .get('/api/v1/geofences')
        .set('Authorization', auth(forgedTuple))
        .expect(401);
    });

    it('revokes geofence access when the backing membership is deleted', async () => {
      const revoked = await register(
        'revoked@example.com',
        'password-R1',
        'Revoked Tenant',
      );
      const decoded = decodeIdentityClaims(jwt, revoked.accessToken);
      await prisma.membership.delete({ where: { id: decoded.mid } });

      await request(server)
        .get('/api/v1/geofences')
        .set('Authorization', auth(revoked.accessToken))
        .expect(401);
    });

    it('rejects an unsigned ("alg: none") token', async () => {
      const b64 = (obj: unknown) =>
        Buffer.from(JSON.stringify(obj)).toString('base64url');
      const noneToken = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
        sub: 'x',
        tid: 'y',
        mid: 'z',
      })}.`;
      await request(server)
        .get('/api/v1/auth/me')
        .set('Authorization', auth(noneToken))
        .expect(401);
    });

    it('rejects a token signed with an alternate algorithm', async () => {
      const claims = decodeIdentityClaims(jwt, tokenA);
      const wrongAlgorithm = await jwt.signAsync(
        { sub: claims.sub, tid: tenantAId, mid: claims.mid },
        { algorithm: 'HS384' },
      );
      await request(server)
        .get('/api/v1/geofences')
        .set('Authorization', auth(wrongAlgorithm))
        .expect(401);
    });
  });

  describe('registration & login against a real database', () => {
    it('rejects a duplicate email with 409 (no Prisma leakage)', async () => {
      const res = await request(server)
        .post('/api/v1/auth/register')
        .send({
          email: 'alice@example.com',
          password: 'another-pass',
          tenantName: 'Dup',
        })
        .expect(409);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('P2002');
      expect(raw.toLowerCase()).not.toContain('unique constraint');
    });

    it('canonicalizes email so case/whitespace variants collide', async () => {
      await request(server)
        .post('/api/v1/auth/register')
        .send({
          email: '  ALICE@example.com ',
          password: 'another-pass',
          tenantName: 'Dup',
        })
        .expect(409);
    });

    it('logs in with correct credentials and returns no hash', async () => {
      const res = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: 'alice@example.com', password: 'password-A1' })
        .expect(200);
      const body = res.body as AuthResponse;
      expect(body.accessToken).toBeTruthy();
      expect(JSON.stringify(body)).not.toContain('passwordHash');
    });

    it('returns the same generic 401 for wrong password and unknown account', async () => {
      const wrong = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: 'alice@example.com', password: 'wrong-password' })
        .expect(401);

      const unknown = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@example.com', password: 'whatever-1' })
        .expect(401);

      // Identical security-relevant response (timestamp naturally differs), so
      // the endpoint reveals nothing about whether the account exists.
      const strip = (body: Record<string, unknown>) => ({
        statusCode: body.statusCode,
        error: body.error,
        message: body.message,
      });
      expect(strip(wrong.body as Record<string, unknown>)).toEqual(
        strip(unknown.body as Record<string, unknown>),
      );
      expect((wrong.body as { message: string }).message).toBe(
        'Invalid credentials',
      );
    });

    it('a freshly logged-in token can access /auth/me', async () => {
      const login = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: 'bob@example.com', password: 'password-B1' })
        .expect(200);
      const token = (login.body as AuthResponse).accessToken;

      const me = await request(server)
        .get('/api/v1/auth/me')
        .set('Authorization', auth(token))
        .expect(200);
      expect((me.body as { tenantId: string }).tenantId).toBe(tenantBId);
    });
  });
});
