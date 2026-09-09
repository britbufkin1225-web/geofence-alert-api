import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { LocationEvent, Prisma } from '@prisma/client';

import { parseStrictIsoDateTime } from '../common/validators/strict-iso-date-time.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLocationEventDto } from './dto/create-location-event.dto';
import { LocationEventResponseDto } from './dto/location-event-response.dto';

/**
 * Location-event ingestion.
 *
 * `tenantId` is always the authoritative value derived from the verified
 * principal. It is never read from the request body, and it is never inferred
 * from the submitted device key: the device lookup is itself tenant-qualified,
 * so a key belonging to another tenant resolves to nothing rather than to that
 * tenant's device.
 *
 * Ownership is additionally structural. `LocationEvent` carries a composite
 * foreign key onto `TrackedDevice (id, tenantId)`, so even a future code path
 * that got this wrong could not persist an event whose tenant disagrees with its
 * device's tenant — PostgreSQL rejects the row.
 */
@Injectable()
export class LocationEventsService {
  constructor(private readonly prisma: PrismaService) {}

  async ingest(
    dto: CreateLocationEventDto,
    tenantId: string,
  ): Promise<LocationEventResponseDto> {
    const device = await this.resolveDevice(dto.deviceKey, tenantId);
    const observedAt = this.parseObservedAt(dto.observedAt);

    const identity = {
      tenantId,
      trackedDeviceId: device.id,
      eventKey: dto.eventKey,
    };

    // Fast path for an ordinary replay: a retry after a lost response is the
    // common case, and answering it with a read is cheaper and quieter than
    // provoking a constraint violation. The create below still handles the race
    // where two copies of the same request arrive at once.
    const existing = await this.prisma.locationEvent.findUnique({
      where: { tenantId_trackedDeviceId_eventKey: identity },
    });

    if (existing) {
      return this.resolveReplay(existing, dto, observedAt, device.deviceKey);
    }

    try {
      const created = await this.prisma.locationEvent.create({
        data: {
          ...identity,
          observedAt,
          latitude: dto.latitude,
          longitude: dto.longitude,
          accuracyMeters: dto.accuracyMeters,
        },
      });

      return this.toResponse(created, device.deviceKey, false);
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }

      // Concurrent duplicate. The database, not the application, decided which
      // submission won; re-read the winner and answer with the same replay or
      // conflict contract, so the outcome does not depend on timing.
      const winner = await this.prisma.locationEvent.findUnique({
        where: { tenantId_trackedDeviceId_eventKey: identity },
      });

      if (!winner) {
        throw error;
      }

      return this.resolveReplay(winner, dto, observedAt, device.deviceKey);
    }
  }

  /**
   * Resolves the device inside the caller's tenant. A key that belongs to
   * another tenant, and a key that exists nowhere, produce the identical 404 —
   * ingestion cannot be used to probe which device keys other tenants use.
   */
  private async resolveDevice(deviceKey: string, tenantId: string) {
    const device = await this.prisma.trackedDevice.findUnique({
      where: { tenantId_deviceKey: { tenantId, deviceKey } },
      select: { id: true, deviceKey: true, isActive: true },
    });

    if (!device) {
      throw new NotFoundException('Tracked device not found');
    }

    // Deactivation is how a tenant stops accepting data from a device, so an
    // inactive device must not be able to keep writing. This 409 is only ever
    // reachable by a caller who already owns the device, so unlike the 404 above
    // it discloses nothing across the tenant boundary.
    if (!device.isActive) {
      throw new ConflictException('Tracked device is not active');
    }

    return device;
  }

  /**
   * The DTO has already validated this string, so a failure here would mean the
   * validation pipe was bypassed. Fail closed with a sanitized 500 rather than
   * persisting an `Invalid Date`.
   */
  private parseObservedAt(value: string): Date {
    const observedAt = parseStrictIsoDateTime(value);

    if (!observedAt) {
      throw new InternalServerErrorException();
    }

    return observedAt;
  }

  /**
   * A stored event and an incoming submission share a key. If every immutable
   * observation field matches, the submission is a genuine retry and is answered
   * with the stored resource. If any of them differs, the key has been reused
   * for a different observation: that is reported as a conflict rather than
   * silently accepted, because answering "success" would tell the client its new
   * data was recorded when it was not, and the stored event is never overwritten.
   */
  private resolveReplay(
    existing: LocationEvent,
    dto: CreateLocationEventDto,
    observedAt: Date,
    deviceKey: string,
  ): LocationEventResponseDto {
    const matches =
      existing.observedAt.getTime() === observedAt.getTime() &&
      existing.latitude === dto.latitude &&
      existing.longitude === dto.longitude &&
      existing.accuracyMeters === dto.accuracyMeters;

    if (!matches) {
      throw new ConflictException(
        'eventKey already used for a different location event',
      );
    }

    return this.toResponse(existing, deviceKey, true);
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private toResponse(
    event: LocationEvent,
    deviceKey: string,
    replayed: boolean,
  ): LocationEventResponseDto {
    return {
      id: event.id,
      tenantId: event.tenantId,
      trackedDeviceId: event.trackedDeviceId,
      deviceKey,
      eventKey: event.eventKey,
      observedAt: event.observedAt,
      receivedAt: event.receivedAt,
      latitude: event.latitude,
      longitude: event.longitude,
      accuracyMeters: event.accuracyMeters,
      replayed,
    };
  }
}
