import { ConflictException, Injectable } from '@nestjs/common';

import { isPrismaUniqueConstraint } from '../common/prisma-unique-constraint';
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
      // Only the tenant/key index means that this device key is registered.
      // Primary-key collisions and unknown metadata remain server errors.
      if (
        isPrismaUniqueConstraint(
          error,
          'TrackedDevice',
          'TrackedDevice_tenantId_deviceKey_key',
        )
      ) {
        throw new ConflictException('Device key already registered');
      }
      throw error;
    }
  }
}
