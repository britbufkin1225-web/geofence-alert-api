import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CreateTrackedDeviceDto } from './dto/create-tracked-device.dto';

/**
 * The minimum tracked-device foundation the GF-4 ingestion path requires: a
 * tenant must be able to own a device before it can submit observations for it.
 *
 * Registration only. Listing, updating, deactivating and deleting devices, plus
 * per-device credentials and enrollment workflows, are deliberately absent —
 * they belong to a device-management phase, not to ingestion.
 *
 * `tenantId` is always supplied by the caller of this service from the verified
 * principal, never from request input.
 */
@Injectable()
export class TrackedDevicesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateTrackedDeviceDto, tenantId: string) {
    try {
      return await this.prisma.trackedDevice.create({
        data: {
          deviceKey: dto.deviceKey,
          name: dto.name,
          isActive: dto.isActive ?? true,
          tenant: { connect: { id: tenantId } },
        },
      });
    } catch (error) {
      // The unique constraint is (tenantId, deviceKey), so this can only ever
      // mean "this tenant already registered that key". It cannot be triggered
      // by, and discloses nothing about, another tenant's devices.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Device key already registered');
      }
      throw error;
    }
  }
}
