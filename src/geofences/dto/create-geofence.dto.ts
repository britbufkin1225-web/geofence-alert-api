export class CreateGeofenceDto {
  name!: string;
  description?: string;
  latitude!: number;
  longitude!: number;
  radiusMeters!: number;
}
