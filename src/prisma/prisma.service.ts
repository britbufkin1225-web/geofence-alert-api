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
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
