import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  GeofenceEvaluationResponseDto,
  GeofenceMatchDto,
} from './dto/geofence-evaluation-response.dto';
import { EVALUATION_DISTANCE_DECIMAL_PLACES } from './dto/geofence-evaluation.constants';
import {
  GeofenceContainmentQuery,
  GeofenceMatchRow,
} from './geofence-containment.query';

/**
 * Rounds a PostGIS distance for serialization only. See
 * EVALUATION_DISTANCE_DECIMAL_PLACES: this never participates in the
 * containment decision, which the database has already made.
 */
export function roundDistanceMeters(distanceMeters: number): number {
  const factor = 10 ** EVALUATION_DISTANCE_DECIMAL_PLACES;

  return Math.round(distanceMeters * factor) / factor;
}

/**
 * Deterministic point-in-circle evaluation (GF-5).
 *
 * Answers one question about one already-persisted observation: which active
 * geofences of the authenticated tenant contain it. The evaluation is
 * synchronous and strictly read-only — it writes no row, mutates no geofence,
 * and produces no transition, alert or delivery record. Those belong to later
 * phases.
 *
 * `tenantId` is always the authoritative value derived from the verified
 * principal. It is never read from the path, query or body. Both database
 * operations carry it as a predicate: the event is resolved with an
 * `id + tenantId` lookup rather than fetched by id and rejected afterwards, and
 * the spatial query filters geofences by the same tenant. A caller therefore
 * cannot learn that another tenant's event exists, and cannot match against
 * another tenant's geofences even when they sit on the same coordinates.
 */
@Injectable()
export class GeofenceEvaluationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly containmentQuery: GeofenceContainmentQuery,
  ) {}

  async evaluate(
    locationEventId: string,
    tenantId: string,
  ): Promise<GeofenceEvaluationResponseDto> {
    const event = await this.prisma.locationEvent.findFirst({
      where: { id: locationEventId, tenantId },
      select: {
        id: true,
        trackedDeviceId: true,
        observedAt: true,
        latitude: true,
        longitude: true,
      },
    });

    // An event owned by another tenant and an event that exists nowhere are the
    // same 404, with the same message, for the same reason as the geofence
    // routes: the API does not disclose the existence of resources outside the
    // caller's tenant.
    if (!event) {
      throw new NotFoundException(
        `Location event with id ${locationEventId} not found`,
      );
    }

    // The database resolves containment against the event's own stored
    // geography point; nothing is recomputed from the scalars above.
    const rows = await this.containmentQuery.findContainingGeofences(
      event.id,
      tenantId,
    );

    const matches = rows.map((row) => this.toMatch(row));

    return {
      locationEventId: event.id,
      trackedDeviceId: event.trackedDeviceId,
      observedAt: event.observedAt,
      latitude: event.latitude,
      longitude: event.longitude,
      matches,
      // Derived from what is actually returned, so the count cannot drift from
      // the array.
      matchCount: matches.length,
    };
  }

  private toMatch(row: GeofenceMatchRow): GeofenceMatchDto {
    return {
      geofenceId: row.geofenceId,
      name: row.name,
      latitude: row.latitude,
      longitude: row.longitude,
      radiusMeters: row.radiusMeters,
      distanceMeters: roundDistanceMeters(row.distanceMeters),
    };
  }
}
