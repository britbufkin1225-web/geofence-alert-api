/* eslint-disable @typescript-eslint/no-unsafe-call */

import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

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
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  limit?: number = 10;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(['name', 'createdAt', 'updatedAt', 'radiusMeters', 'isActive'])
  sortBy?: GeofenceSortBy = 'createdAt';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: SortOrder = 'desc';
}
