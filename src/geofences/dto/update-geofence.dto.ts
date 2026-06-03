export class UpdateGeofenceDto {
  name?: string;
  description?: string;
  latitude?: number;
  longitude?: number;
  radiusMeters?: number;
  isActive?: boolean;
}
