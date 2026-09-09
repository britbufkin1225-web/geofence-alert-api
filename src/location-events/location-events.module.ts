import { Module } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import { LocationEventsController } from './location-events.controller';
import { LocationEventsService } from './location-events.service';

@Module({
  controllers: [LocationEventsController],
  providers: [LocationEventsService, PrismaService],
})
export class LocationEventsModule {}
