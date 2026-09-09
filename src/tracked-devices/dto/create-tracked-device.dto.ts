import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { trim } from '../../common/transforms/trim.transform';
import {
  DEVICE_KEY_MAX_LENGTH,
  DEVICE_KEY_MIN_LENGTH,
  DEVICE_KEY_PATTERN,
  DEVICE_NAME_MAX_LENGTH,
  DEVICE_NAME_MIN_LENGTH,
} from './tracked-device.constants';

/**
 * There is deliberately no `tenantId` property. Tenant ownership is taken from
 * the authenticated principal in the controller, and the global validation pipe
 * runs with `forbidNonWhitelisted`, so a client that sends one is rejected with
 * a 400 rather than having it quietly dropped.
 */
export class CreateTrackedDeviceDto {
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MinLength(DEVICE_KEY_MIN_LENGTH)
  @MaxLength(DEVICE_KEY_MAX_LENGTH)
  @Matches(DEVICE_KEY_PATTERN, {
    message:
      'deviceKey may contain only letters, digits, dot, underscore, colon and hyphen',
  })
  deviceKey!: string;

  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MinLength(DEVICE_NAME_MIN_LENGTH)
  @MaxLength(DEVICE_NAME_MAX_LENGTH)
  name!: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}
