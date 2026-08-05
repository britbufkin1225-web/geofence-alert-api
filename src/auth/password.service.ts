import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

import { PASSWORD_MAX_BYTES, PASSWORD_SALT_ROUNDS } from './auth.constants';

/**
 * Password hashing/verification using bcrypt (bcryptjs). Plaintext passwords are
 * only ever held transiently here to hash or compare and are never stored or
 * logged.
 */
@Injectable()
export class PasswordService {
  async hash(plain: string): Promise<string> {
    this.assertWithinBcryptLimit(plain);
    return bcrypt.hash(plain, PASSWORD_SALT_ROUNDS);
  }

  async verify(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  /**
   * bcrypt silently truncates input beyond 72 bytes. DTO validation already
   * bounds password length, but this is defense-in-depth against any caller
   * that bypasses the DTO.
   */
  private assertWithinBcryptLimit(plain: string): void {
    if (Buffer.byteLength(plain, 'utf8') > PASSWORD_MAX_BYTES) {
      throw new Error('Password exceeds the maximum supported length');
    }
  }
}
