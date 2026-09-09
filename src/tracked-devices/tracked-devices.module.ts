import { Module } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import { TrackedDevicesController } from './tracked-devices.controller';
import { TrackedDevicesService } from './tracked-devices.service';

@Module({
  controllers: [TrackedDevicesController],
  providers: [TrackedDevicesService, PrismaService],
})
export class TrackedDevicesModule {}
