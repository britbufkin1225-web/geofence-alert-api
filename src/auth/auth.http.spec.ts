import type { Server } from 'http';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../app.module';
import { setupApp } from '../app.setup';
import { PrismaService } from '../prisma/prisma.service';

/**
 * HTTP-level validation matrix for the auth surface. Prisma is mocked because
 * every case here is rejected by the global ValidationPipe BEFORE reaching the
 * service, so no database is required. Happy-path register/login/me behavior and
 * the tenant boundary are proven separately against a real SQLite database in
 * tenant-isolation.spec.ts.
 */

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

const validRegister = {
  email: 'new@example.com',
  password: 'password-123',
  tenantName: 'Acme',
};

describe('Auth API validation (HTTP)', () => {
  let app: INestApplication;
  let server: Server;

  // Never invoked by these tests (validation rejects first), but present so the
  // module can be constructed.
  const mockPrisma = {
    user: { findUnique: jest.fn(), create: jest.fn() },
    tenant: { create: jest.fn(), findUniqueOrThrow: jest.fn() },
    membership: { create: jest.fn(), findFirst: jest.fn() },
    $transaction: jest.fn(),
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

  afterEach(() => {
    // Prove none of the validation-failure cases reached the persistence layer.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    jest.clearAllMocks();
  });

  const postRegister = (body: unknown) =>
    request(server).post('/api/v1/auth/register').send(body);
  const postLogin = (body: unknown) =>
    request(server).post('/api/v1/auth/login').send(body);

  describe('registration', () => {
    it('rejects a malformed email', async () => {
      await postRegister({ ...validRegister, email: 'not-an-email' }).expect(
        400,
      );
    });

    it('rejects a blank email', async () => {
      await postRegister({ ...validRegister, email: '   ' }).expect(400);
    });

    it('rejects a null email (null does not bypass a required field)', async () => {
      await postRegister({ ...validRegister, email: null }).expect(400);
    });

    it('rejects an overly long identity input', async () => {
      const email = `${'a'.repeat(250)}@example.com`;
      await postRegister({ ...validRegister, email }).expect(400);
    });

    it('rejects a weak/short password', async () => {
      await postRegister({ ...validRegister, password: 'short' }).expect(400);
    });

    it('rejects an overly long password', async () => {
      await postRegister({
        ...validRegister,
        password: 'a'.repeat(73),
      }).expect(400);
    });

    it('rejects a null password', async () => {
      await postRegister({ ...validRegister, password: null }).expect(400);
    });

    it('rejects an unknown field', async () => {
      const res = await postRegister({
        ...validRegister,
        isAdmin: true,
      }).expect(400);
      expect((res.body as ErrorBody).message).toEqual(
        expect.arrayContaining([expect.stringContaining('isAdmin')]),
      );
    });

    it('rejects a blank tenant name', async () => {
      await postRegister({ ...validRegister, tenantName: '   ' }).expect(400);
    });

    it('rejects a missing tenant name', async () => {
      const { tenantName: _omit, ...body } = validRegister;
      void _omit;
      await postRegister(body).expect(400);
    });
  });

  describe('login', () => {
    it('rejects an empty body', async () => {
      await postLogin({}).expect(400);
    });

    it('rejects a malformed email', async () => {
      await postLogin({ email: 'nope', password: 'password-123' }).expect(400);
    });

    it('rejects a missing password', async () => {
      await postLogin({ email: 'user@example.com' }).expect(400);
    });

    it('rejects an overly long password before hashing work', async () => {
      await postLogin({
        email: 'user@example.com',
        password: 'a'.repeat(73),
      }).expect(400);
    });
  });

  describe('protected auth route', () => {
    it('requires a token for /auth/me', async () => {
      await request(server).get('/api/v1/auth/me').expect(401);
    });
  });
});
