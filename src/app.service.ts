import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service';

type DatabaseStatusResponse = {
  database: string;
  provider: string;
  status: string;
};

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  getHello(): string {
    return 'GeoFence Alert API is connected to Prisma';
  }

  async getDatabaseStatus(): Promise<DatabaseStatusResponse> {
    await this.prisma.$queryRaw`SELECT 1`;

    return {
      database: 'connected',
      // PostgreSQL is the only supported provider (GF-3). This is a literal
      // rather than a value read from DATABASE_URL, so the authenticated
      // response can never echo host, port or credentials.
      provider: 'postgresql',
      status: 'ok',
    };
  }
}
