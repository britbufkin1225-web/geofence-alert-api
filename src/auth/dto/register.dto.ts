import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { normalizeEmail } from '../../common/transforms/normalize-email.transform';
import { trim } from '../../common/transforms/trim.transform';
import {
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  TENANT_NAME_MAX_LENGTH,
  TENANT_NAME_MIN_LENGTH,
} from '../auth.constants';

export class RegisterDto {
  @IsString()
  @Transform(normalizeEmail)
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;

  // Password is intentionally NOT trimmed or transformed. Bounds protect both
  // usability and resource consumption (and avoid bcrypt's 72-byte truncation).
  @IsString()
  @IsNotEmpty()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MinLength(TENANT_NAME_MIN_LENGTH)
  @MaxLength(TENANT_NAME_MAX_LENGTH)
  tenantName!: string;
}
