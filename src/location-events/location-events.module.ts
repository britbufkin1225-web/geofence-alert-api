import { Module } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import { GeofenceAlertQuery } from './geofence-alert.query';
import { GeofenceAlertService } from './geofence-alert.service';
import { GeofenceContainmentQuery } from './geofence-containment.query';
import { GeofenceEvaluationService } from './geofence-evaluation.service';
import { GeofenceTransitionQuery } from './geofence-transition.query';
import { GeofenceTransitionService } from './geofence-transition.service';
import { LocationEventsController } from './location-events.controller';
import { LocationEventsService } from './location-events.service';

@Module({
  controllers: [LocationEventsController],
  providers: [
    LocationEventsService,
    GeofenceEvaluationService,
    GeofenceContainmentQuery,
    GeofenceTransitionService,
    GeofenceTransitionQuery,
    GeofenceAlertService,
    GeofenceAlertQuery,
    PrismaService,
  ],
})
export class LocationEventsModule {}
