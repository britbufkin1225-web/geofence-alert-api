import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';

import { JWT_ALGORITHM } from './auth.constants';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PasswordService } from './password.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // No fallback secret: env validation guarantees JWT_SECRET is present.
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          // config values are plain strings (e.g. "1h"); cast to the library's
          // expiresIn type, which jsonwebtoken parses at runtime.
          expiresIn: (config.get<string>('JWT_EXPIRES_IN') ??
            '1h') as JwtSignOptions['expiresIn'],
          algorithm: JWT_ALGORITHM,
        },
        verifyOptions: {
          algorithms: [JWT_ALGORITHM],
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    // Registered as APP_GUARD so every route is authenticated by default
    // (opt-out via @Public()), which fails closed for routes added later.
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AuthModule {}
