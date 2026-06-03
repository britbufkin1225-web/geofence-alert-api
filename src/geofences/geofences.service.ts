import { Injectable } from '@nestjs/common';

@Injectable()
export class GeofencesService {
  getModuleStatus() {
    return {
      module: 'geofences',
      status: 'active',
      message: 'Geofences domain module is connected.',
    };
  }
}
