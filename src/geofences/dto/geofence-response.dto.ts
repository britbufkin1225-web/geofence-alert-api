export class GeofenceResponseDto {
  id!: string;
  tenantId!: string;
  name!: string;
  description!: string | null;
  latitude!: number;
  longitude!: number;
  radiusMeters!: number;
  isActive!: boolean;
  createdAt!: Date;
  updatedAt!: Date;
}
