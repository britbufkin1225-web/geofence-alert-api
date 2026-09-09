import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { envValidationSchema } from './config/env.validation';
import { GeofencesModule } from './geofences/geofences.module';
import { HealthModule } from './health/health.module';
import { LocationEventsModule } from './location-events/location-events.module';
import { PrismaModule } from './prisma/prisma.module';
import { TrackedDevicesModule } from './tracked-devices/tracked-devices.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validationSchema: envValidationSchema,
    }),
    PrismaModule,
    AuthModule,
    HealthModule,
    GeofencesModule,
    TrackedDevicesModule,
    LocationEventsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
