import { Module } from '@nestjs/common';
import { GeofencesService } from './geofences.service';
import { GeofencesController } from './geofences.controller';

@Module({
  providers: [GeofencesService],
  controllers: [GeofencesController],
})
export class GeofencesModule {}
