export class GeofenceResponseDto {
  id!: string;
  name!: string;
  description!: string | null;
  latitude!: number;
  longitude!: number;
  radiusMeters!: number;
  isActive!: boolean;
  createdAt!: Date;
  updatedAt!: Date;
}
