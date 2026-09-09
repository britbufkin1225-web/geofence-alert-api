import { Module } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import { GeofenceContainmentQuery } from './geofence-containment.query';
import { GeofenceEvaluationService } from './geofence-evaluation.service';
import { LocationEventsController } from './location-events.controller';
import { LocationEventsService } from './location-events.service';

@Module({
  controllers: [LocationEventsController],
  providers: [
    LocationEventsService,
    GeofenceEvaluationService,
    GeofenceContainmentQuery,
    PrismaService,
  ],
})
export class LocationEventsModule {}
