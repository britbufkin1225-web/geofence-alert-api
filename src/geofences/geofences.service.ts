import { Injectable } from '@nestjs/common';

import { CreateGeofenceDto } from './dto/create-geofence.dto';

@Injectable()
export class GeofencesService {
  create(createGeofenceDto: CreateGeofenceDto) {
    return {
      message: 'Geofence create endpoint reached',
      data: createGeofenceDto,
    };
  }

  findAll() {
    return {
      message: 'Geofence list endpoint reached',
      data: [],
    };
  }

  findOne(id: string) {
    return {
      message: 'Geofence detail endpoint reached',
      data: {
        id,
      },
    };
  }
}
