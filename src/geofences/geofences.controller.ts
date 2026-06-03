import { Body, Controller, Get, Param, Post } from '@nestjs/common';

import { CreateGeofenceDto } from './dto/create-geofence.dto';
import { GeofencesService } from './geofences.service';

@Controller('geofences')
export class GeofencesController {
  constructor(private readonly geofencesService: GeofencesService) {}

  @Post()
  create(@Body() createGeofenceDto: CreateGeofenceDto) {
    return this.geofencesService.create(createGeofenceDto);
  }

  @Get()
  findAll() {
    return this.geofencesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.geofencesService.findOne(id);
  }
}
