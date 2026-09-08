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

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedPrincipal } from '../auth/principal';
import { ParseCuidPipe } from '../common/pipes/parse-cuid.pipe';
import { CreateGeofenceDto } from './dto/create-geofence.dto';
import { UpdateGeofenceDto } from './dto/update-geofence.dto';
import { QueryGeofencesDto } from './dto/query-geofences.dto';
import { GeofencesService } from './geofences.service';

// Every route here is protected by the global JwtAuthGuard. The tenant context
// is taken from the verified principal and passed to the service; it is never
// read from the request body, query, params, or a client-supplied header.
@Controller('geofences')
export class GeofencesController {
  constructor(private readonly geofencesService: GeofencesService) {}

  @Post()
  create(
    @Body() createGeofenceDto: CreateGeofenceDto,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ) {
    return this.geofencesService.create(createGeofenceDto, principal.tenantId);
  }

  @Get()
  findAll(
    @Query() query: QueryGeofencesDto,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ) {
    return this.geofencesService.findAll(query, principal.tenantId);
  }

  @Get('summary')
  getSummary(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.geofencesService.getSummary(principal.tenantId);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseCuidPipe) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ) {
    return this.geofencesService.findOne(id, principal.tenantId);
  }

  @Patch(':id')
  update(
    @Param('id', ParseCuidPipe) id: string,
    @Body() updateGeofenceDto: UpdateGeofenceDto,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ) {
    return this.geofencesService.update(
      id,
      updateGeofenceDto,
      principal.tenantId,
    );
  }

  @Delete(':id')
  remove(
    @Param('id', ParseCuidPipe) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ) {
    return this.geofencesService.remove(id, principal.tenantId);
  }
}
