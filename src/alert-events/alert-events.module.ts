import { Module } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import { AlertEventsController } from './alert-events.controller';
import { AlertEventsService } from './alert-events.service';

@Module({
  controllers: [AlertEventsController],
  providers: [AlertEventsService, PrismaService],
})
export class AlertEventsModule {}
