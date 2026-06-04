import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { CreateGeofenceDto } from './dto/create-geofence.dto';
import { UpdateGeofenceDto } from './dto/update-geofence.dto';
import { QueryGeofencesDto } from './dto/query-geofences.dto';
import { GeofencesService } from './geofences.service';

@Controller('geofences')
export class GeofencesController {
  constructor(private readonly geofencesService: GeofencesService) {}

  @Post()
  create(@Body() createGeofenceDto: CreateGeofenceDto) {
    return this.geofencesService.create(createGeofenceDto);
  }

  @Get()
  findAll(@Query() query: QueryGeofencesDto) {
    return this.geofencesService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.geofencesService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateGeofenceDto: UpdateGeofenceDto,
  ) {
    return this.geofencesService.update(id, updateGeofenceDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.geofencesService.remove(id);
  }
}
