import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { normalizeEmail } from '../../common/transforms/normalize-email.transform';
import {
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_BYTES,
  PASSWORD_MAX_LENGTH,
} from '../auth.constants';
import { MaxUtf8Bytes } from '../validators/max-utf8-bytes.decorator';

export class LoginDto {
  @IsString()
  @Transform(normalizeEmail)
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;

  // Bounded and required, but no minimum-length check here: login must not
  // reveal the password policy, and the password is never trimmed. The upper
  // bound prevents unbounded input and bcrypt truncation ambiguity.
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  @MaxUtf8Bytes(PASSWORD_MAX_BYTES)
  password!: string;
}
