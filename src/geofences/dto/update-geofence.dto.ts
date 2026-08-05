import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { AtLeastOneField } from '../../common/validators/at-least-one-field.decorator';
import { trim } from '../../common/transforms/trim.transform';
import {
  GEOFENCE_DESCRIPTION_MAX_LENGTH,
  GEOFENCE_LATITUDE_MAX,
  GEOFENCE_LATITUDE_MIN,
  GEOFENCE_LONGITUDE_MAX,
  GEOFENCE_LONGITUDE_MIN,
  GEOFENCE_NAME_MAX_LENGTH,
  GEOFENCE_NAME_MIN_LENGTH,
  GEOFENCE_RADIUS_MAX_METERS,
  GEOFENCE_RADIUS_MIN_METERS,
} from './geofence.constants';

@AtLeastOneField()
export class UpdateGeofenceDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MinLength(GEOFENCE_NAME_MIN_LENGTH)
  @MaxLength(GEOFENCE_NAME_MAX_LENGTH)
  name?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsNumber()
  @Min(GEOFENCE_LATITUDE_MIN)
  @Max(GEOFENCE_LATITUDE_MAX)
  latitude?: number;

  @ValidateIf((_object, value) => value !== undefined)
  @IsNumber()
  @Min(GEOFENCE_LONGITUDE_MIN)
  @Max(GEOFENCE_LONGITUDE_MAX)
  longitude?: number;

  @ValidateIf((_object, value) => value !== undefined)
  @IsNumber()
  @Min(GEOFENCE_RADIUS_MIN_METERS)
  @Max(GEOFENCE_RADIUS_MAX_METERS)
  radiusMeters?: number;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Transform(trim)
  @MaxLength(GEOFENCE_DESCRIPTION_MAX_LENGTH)
  description?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}
