import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  GEOFENCE_SEARCH_MAX_LENGTH,
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_DEFAULT_PAGE,
  PAGINATION_MAX_LIMIT,
  PAGINATION_MIN_LIMIT,
} from './geofence.constants';

function toNumber({ value }: TransformFnParams): unknown {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return Number(value);
  }

  return value;
}

function toBoolean({ value }: TransformFnParams): unknown {
  if (value === true || value === false) {
    return value;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return value;
}

type GeofenceSortBy =
  | 'name'
  | 'createdAt'
  | 'updatedAt'
  | 'radiusMeters'
  | 'isActive';

type SortOrder = 'asc' | 'desc';

export class QueryGeofencesDto {
  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(PAGINATION_MIN_LIMIT)
  page?: number = PAGINATION_DEFAULT_PAGE;

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(PAGINATION_MIN_LIMIT)
  @Max(PAGINATION_MAX_LIMIT)
  limit?: number = PAGINATION_DEFAULT_LIMIT;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(GEOFENCE_SEARCH_MAX_LENGTH)
  search?: string;

  @IsOptional()
  @IsIn(['name', 'createdAt', 'updatedAt', 'radiusMeters', 'isActive'])
  sortBy?: GeofenceSortBy = 'createdAt';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: SortOrder = 'desc';
}
