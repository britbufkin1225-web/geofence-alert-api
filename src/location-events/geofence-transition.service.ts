import { Injectable } from '@nestjs/common';
import { GeofenceContainmentState, GeofenceTransition } from '@prisma/client';

import { GeofenceTransitionDto } from './dto/geofence-transition-response.dto';
import { roundDistanceMeters } from './geofence-evaluation.service';
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
 * What this service does NOT do is as much of the contract as what it does. It
 * creates no alert, notification or delivery record and schedules no work; the
 * only row it writes is the current-state row the next comparison reads.
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
  constructor(private readonly transitionQuery: GeofenceTransitionQuery) {}

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
    const { rows, stored } = await this.transitionQuery.evaluateAndAdvance(
      locationEventId,
      tenantId,
    );

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
      ),
    );
  }

  private toTransition(
    row: GeofenceTransitionRow,
    locationEventId: string,
    stored: GeofenceStoredStateRow | undefined,
  ): GeofenceTransitionDto {
    return {
      geofenceId: row.geofenceId,
      name: row.name,
      radiusMeters: row.radiusMeters,
      distanceMeters: roundDistanceMeters(row.distanceMeters),
      state: row.state,
      transition: this.classify(row, locationEventId, stored),
      stateAdvanced: row.advancedTransition !== null,
    };
  }

  /**
   * The database already classified every observation that advanced state, from
   * the row it overwrote. Only the two non-advancing cases are decided here:
   *
   * - a replay of the event that wrote the current state answers with that
   *   event's own stored classification, so ingesting the same event twice
   *   cannot describe one crossing two different ways;
   * - anything else is an observation older than the current state. It is
   *   reported as a `STAY_*` at its own containment, never as `ENTER` or `EXIT`:
   *   it is not evidence that the device crossed anything, and the state it
   *   would have to be compared against belongs to a later observation.
   *
   * Conflicting-row locks protect the stored-state read through transaction
   * completion. A missing row is a defensive fallback, not an expected
   * deactivation interleaving.
   */
  private classify(
    row: GeofenceTransitionRow,
    locationEventId: string,
    stored: GeofenceStoredStateRow | undefined,
  ): GeofenceTransition {
    if (row.advancedTransition !== null) {
      return row.advancedTransition;
    }

    if (stored?.lastLocationEventId === locationEventId) {
      return stored.lastTransition;
    }

    return row.state === GeofenceContainmentState.INSIDE
      ? GeofenceTransition.STAY_INSIDE
      : GeofenceTransition.STAY_OUTSIDE;
  }
}
