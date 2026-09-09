import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { LocationEvent } from '@prisma/client';

import { isPrismaUniqueConstraint } from '../common/prisma-unique-constraint';
import { parseStrictIsoDateTime } from '../common/validators/strict-iso-date-time.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLocationEventDto } from './dto/create-location-event.dto';
import { GeofenceTransitionDto } from './dto/geofence-transition-response.dto';
import { LocationEventResponseDto } from './dto/location-event-response.dto';
import { GeofenceTransitionService } from './geofence-transition.service';

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
 *
 * Since GF-6, an accepted event is also classified against the tenant's active
 * geofences before the response is written. That step runs only once the event
 * is stored and only for an event this tenant owns, so transition state is never
 * advanced by an observation that ingestion itself rejected.
 */
@Injectable()
export class LocationEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly geofenceTransitions: GeofenceTransitionService,
  ) {}

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
      return this.completeReplay(existing, dto, observedAt, device, tenantId);
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

      return this.complete(created, device.deviceKey, false, tenantId);
    } catch (error) {
      if (
        !isPrismaUniqueConstraint(
          error,
          'LocationEvent',
          'LocationEvent_tenantId_trackedDeviceId_eventKey_key',
        )
      ) {
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

      return this.completeReplay(winner, dto, observedAt, device, tenantId);
    }
  }

  /**
   * Classifies the stored event against the tenant's active geofences and
   * assembles the response.
   *
   * Transition detection runs on the replay path too, and deliberately so: the
   * first attempt may have stored the event and then failed before advancing
   * state, and the retry that reaches the replay path is what completes it. The
   * advancement itself is guarded by the observation ordering, so re-running it
   * for an event that still owns state changes nothing and reports the same
   * classification. A superseded event follows the stale-observation policy.
   *
   * A failure here fails the request rather than being swallowed. The event
   * stays stored, so the client's next retry with the same `eventKey` resolves
   * to the same event. It repairs missing state only if no newer observation has
   * superseded it; no historical comparison can be reconstructed afterward.
   */
  private async complete(
    event: LocationEvent,
    deviceKey: string,
    replayed: boolean,
    tenantId: string,
  ): Promise<LocationEventResponseDto> {
    const geofenceTransitions = await this.geofenceTransitions.evaluate(
      event.id,
      tenantId,
    );

    return this.toResponse(event, deviceKey, replayed, geofenceTransitions);
  }

  /**
   * A replay is only completed once it has been proven identical to the stored
   * event, so a conflicting reuse of an `eventKey` raises 409 without ever
   * reaching transition detection.
   */
  private async completeReplay(
    existing: LocationEvent,
    dto: CreateLocationEventDto,
    observedAt: Date,
    device: { deviceKey: string },
    tenantId: string,
  ): Promise<LocationEventResponseDto> {
    this.assertReplayMatches(existing, dto, observedAt);

    return this.complete(existing, device.deviceKey, true, tenantId);
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
  private assertReplayMatches(
    existing: LocationEvent,
    dto: CreateLocationEventDto,
    observedAt: Date,
  ): void {
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
  }

  private toResponse(
    event: LocationEvent,
    deviceKey: string,
    replayed: boolean,
    geofenceTransitions: GeofenceTransitionDto[],
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
      geofenceTransitions,
    };
  }
}
