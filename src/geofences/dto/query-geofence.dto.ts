import { IsBooleanString, IsOptional, IsString } from 'class-validator';

export class QueryGeofenceDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsBooleanString()
  active?: string;
}
