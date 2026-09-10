import { Injectable } from '@nestjs/common';

import { GeofenceTransitionDto } from './dto/geofence-transition-response.dto';
import {
  GeofenceAlertIndex,
  GeofenceAlertService,
} from './geofence-alert.service';
import { roundDistanceMeters } from './geofence-evaluation.service';
import { classifyTransition } from './geofence-transition.classification';
import {
  GeofenceStoredStateRow,
  GeofenceTransitionQuery,
  GeofenceTransitionRow,
} from './geofence-transition.query';

/**
 * Deterministic geofence transition detection (GF-6).
 *
 * Classifies how one already-persisted, already-authorized observation changed a
 * device's position relative to each active geofence of its tenant, and advances
 * the minimum persistent state that makes the next such comparison possible.
 *
 * Since GF-7 an accepted `ENTER` or `EXIT` also carries the durable alert that
 * crossing resolved to. This service does not decide, create or deduplicate that
 * alert — GeofenceAlertService does, inside the transition transaction — and it
 * still schedules no work and delivers nothing.
 *
 * Every decision that could be wrong under concurrency is made by the database,
 * in one statement (see geofence-transition.query.ts). This class only labels
 * the outcomes the database could not have reached on its own: what a
 * non-advancing observation should be told.
 *
 * `tenantId` is always the authoritative value derived from the verified
 * principal. It is never read from the body, path or query, and the device is
 * derived from the stored event rather than supplied, so a caller cannot aim
 * this at another tenant's or another device's state.
 */
@Injectable()
export class GeofenceTransitionService {
  constructor(
    private readonly transitionQuery: GeofenceTransitionQuery,
    private readonly alerts: GeofenceAlertService,
  ) {}

  /**
   * Returns one entry per active geofence of `tenantId`, ordered by ascending
   * distance and then ascending geofence id — the same total order GF-5 uses.
   *
   * The caller is responsible for having established that `locationEventId`
   * belongs to `tenantId`; the statements re-qualify it by tenant anyway, so an
   * event outside the tenant simply evaluates to nothing rather than to another
   * tenant's geofences. A tenant with no active geofence gets an empty list,
   * which is a successful evaluation.
   */
  async evaluate(
    locationEventId: string,
    tenantId: string,
  ): Promise<GeofenceTransitionDto[]> {
    const { rows, stored, alerts } =
      await this.transitionQuery.evaluateAndAdvance(locationEventId, tenantId);

    const storedByGeofence = new Map(
      stored.map((row): [string, GeofenceStoredStateRow] => [
        row.geofenceId,
        row,
      ]),
    );

    return rows.map((row) =>
      this.toTransition(
        row,
        locationEventId,
        storedByGeofence.get(row.geofenceId),
        alerts,
      ),
    );
  }

  /**
   * Serializes one evaluated geofence.
   *
   * `classifyTransition` is the single authoritative rule, shared with the alert
   * boundary that already persisted the crossings inside the transaction above,
   * so the classification reported here and the alert attached to it describe the
   * same event by construction. `alert` is added only for a crossing; the key is
   * absent otherwise rather than present and null, so the additive GF-7 field
   * cannot be mistaken for an alert that failed to materialize.
   */
  private toTransition(
    row: GeofenceTransitionRow,
    locationEventId: string,
    stored: GeofenceStoredStateRow | undefined,
    alerts: GeofenceAlertIndex,
  ): GeofenceTransitionDto {
    const transition = classifyTransition(row, locationEventId, stored);
    const alert = this.alerts.describe(row.geofenceId, transition, alerts);

    return {
      geofenceId: row.geofenceId,
      name: row.name,
      radiusMeters: row.radiusMeters,
      distanceMeters: roundDistanceMeters(row.distanceMeters),
      state: row.state,
      transition,
      stateAdvanced: row.advancedTransition !== null,
      ...(alert ? { alert } : {}),
    };
  }
}
