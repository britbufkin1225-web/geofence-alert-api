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
      provider: 'sqlite',
      status: 'ok',
    };
  }
}
