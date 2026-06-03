import { Controller, Get } from '@nestjs/common';
import { GeofencesService } from './geofences.service';

@Controller('geofences')
export class GeofencesController {
  constructor(private readonly geofencesService: GeofencesService) {}

  @Get()
  getModuleStatus() {
    return this.geofencesService.getModuleStatus();
  }
}
