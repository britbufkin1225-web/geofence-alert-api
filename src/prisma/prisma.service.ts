import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const connectionString = process.env.DATABASE_URL;

    // Fail closed. The pre-GF-3 service fell back to a local SQLite file when
    // DATABASE_URL was absent, which could silently start the application
    // against the wrong database; there is no safe default for PostgreSQL.
    // ConfigModule validates this at startup too — this guard also covers code
    // paths that construct PrismaService outside the Nest bootstrap.
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set. A PostgreSQL connection string is required.',
      );
    }

    // PostgreSQL driver adapter. The connection string is never logged: Prisma
    // errors surface through the global exception filter, which does not expose
    // driver internals to API clients.
    // adapter-pg 7.8 normalizes timestamptz offsets by replacing them with UTC
    // without shifting the wall time. GF-4 uses timestamptz, so every application
    // connection must return UTC, regardless of database/role/URL defaults.
    const url = new URL(connectionString);
    url.searchParams.set(
      'options',
      `${url.searchParams.get('options') ?? ''} -c timezone=UTC`.trim(),
    );
    super({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
