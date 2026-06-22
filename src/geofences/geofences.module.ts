import { Module } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import { GeofencesController } from './geofences.controller';
import { GeofencesService } from './geofences.service';

@Module({
  controllers: [GeofencesController],
  providers: [GeofencesService, PrismaService],
})
export class GeofencesModule {}
