import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { GeofenceTransition, Prisma } from '@prisma/client';

import { GeofenceAlertDto } from './dto/geofence-alert-response.dto';
import { isAlertProducingTransition } from './geofence-alert.policy';
import {
  GeofenceAlertCandidate,
  GeofenceAlertQuery,
  GeofenceAlertRow,
} from './geofence-alert.query';
import { classifyTransition } from './geofence-transition.classification';
import {
  GeofenceStoredStateRow,
  GeofenceTransitionRow,
} from './geofence-transition.query';

/** Persisted alerts for one ingestion, looked up by the geofence crossed. */
export type GeofenceAlertIndex = ReadonlyMap<string, GeofenceAlertRow>;

/**
 * Deterministic alert-event creation and deduplication (GF-7).
 *
 * Turns authoritative GF-6 classifications into durable alert events, exactly
 * once each, and maps what the response is allowed to say about them.
 *
 * What this service does NOT do is again most of the contract. It sends nothing,
 * schedules nothing, retries nothing and owns no queue, worker or outbox. An
 * alert here is a recorded fact, not a message; the phase that delivers it will
 * read these rows, and the fact that it does not exist yet is why there is no
 * delivery column to leave permanently false.
 *
 * It also creates no alert of its own accord. Every candidate is derived from
 * rows PostgreSQL returned inside the transition transaction, through the same
 * `classifyTransition` the response is built from, so an alert can only describe
 * a crossing the API reported in the very same request.
 */
@Injectable()
export class GeofenceAlertService {
  constructor(private readonly alertQuery: GeofenceAlertQuery) {}

  /**
   * Records every accepted crossing this observation owns, and returns the
   * stored alerts indexed by geofence.
   *
   * Called with the transaction that advanced the transition state, and
   * deliberately so: an `ENTER` or `EXIT` that commits without its alert is a
   * crossing the system can never re-derive, because the state row that proves
   * it has already moved on. Sharing the transaction makes that pair atomic — a
   * failure here rolls the advancement back with it, and the client's next
   * attempt with the same event key classifies the same crossing again.
   *
   * Replay and repair are the same code path as first arrival. A candidate is
   * produced whenever the current state of a geofence is a crossing owned by
   * this event, on the advancing request and replays while it still owns state.
   * First arrival inserts; a replay conflicts and reuses;
   * a replay after a failure that lost the alert inserts the missing one. None
   * of the three needs to know which it is.
   *
   * `tenantId` is the authoritative value from the verified principal, and the
   * device, geofence, direction and observation instant all come from the
   * stored rows. The original observation time and deviceKey came from validated
   * ingestion input; alert-specific provenance is not accepted from a caller.
   */
  async record(
    tx: Prisma.TransactionClient,
    tenantId: string,
    locationEventId: string,
    rows: GeofenceTransitionRow[],
    stored: GeofenceStoredStateRow[],
  ): Promise<GeofenceAlertIndex> {
    const candidates = this.candidates(locationEventId, rows, stored);

    const alerts = await this.alertQuery.persistAndRead(
      tx,
      tenantId,
      locationEventId,
      candidates,
    );

    const index = new Map(alerts.map((alert) => [alert.geofenceId, alert]));

    // Exactly one stored alert per accepted crossing, and no others. Both halves
    // matter, and neither may be reported as success:
    //
    //   * fewer rows than candidates means a crossing was accepted that the
    //     database has no record of, and the response would describe an `ENTER`
    //     that was never stored;
    //   * more rows than candidates, or two rows for one geofence, means the
    //     read-back matched something other than the crossings just accepted,
    //     and attaching one of them would name the wrong alert.
    //
    // Throwing inside the transaction rolls the transition advancement back too,
    // so the crossing stays re-derivable by the next replay rather than becoming
    // an unrecoverable gap.
    if (
      alerts.length !== candidates.length ||
      index.size !== candidates.length
    ) {
      throw new InternalServerErrorException();
    }

    return index;
  }

  /**
   * The alert to expose for one classified geofence, or `undefined` when the
   * classification is not a crossing.
   *
   * The policy is applied here as well as at persistence, from the same
   * function, so the response cannot advertise an alert for a baseline or a stay
   * even if one somehow existed in the table.
   */
  describe(
    geofenceId: string,
    transition: GeofenceTransition,
    alerts: GeofenceAlertIndex,
  ): GeofenceAlertDto | undefined {
    if (!isAlertProducingTransition(transition)) {
      return undefined;
    }

    const alert = alerts.get(geofenceId);

    // Both conditions are unreachable through `record` above, which refuses to
    // return an incomplete index, and through the read-back, which matches the
    // direction exactly. They are asserted rather than assumed because the
    // alternative failure is silent and wrong: an ENTER reported with no alert,
    // or with the identity of a different crossing.
    if (!alert || alert.transition !== transition) {
      throw new InternalServerErrorException();
    }

    return { id: alert.id, createdAt: alert.createdAt };
  }

  /**
   * The crossings this observation owns, at most one per evaluated geofence.
   *
   * `classifyTransition` is the same authoritative answer the response reports,
   * so the set of alerts and the set of `ENTER`/`EXIT` results in the body are
   * the same set by construction rather than by coincidence. Everything else —
   * baselines, stays, and the `STAY_*` a superseded observation is told — is
   * silently skipped.
   */
  private candidates(
    locationEventId: string,
    rows: GeofenceTransitionRow[],
    stored: GeofenceStoredStateRow[],
  ): GeofenceAlertCandidate[] {
    const storedByGeofence = new Map(
      stored.map((row): [string, GeofenceStoredStateRow] => [
        row.geofenceId,
        row,
      ]),
    );

    return rows
      .map((row) => ({
        row,
        transition: classifyTransition(
          row,
          locationEventId,
          storedByGeofence.get(row.geofenceId),
        ),
      }))
      .filter(({ transition }) => isAlertProducingTransition(transition))
      .map(({ row, transition }) => ({
        geofenceId: row.geofenceId,
        trackedDeviceId: row.trackedDeviceId,
        transition,
        observedAt: row.observedAt,
      }));
  }
}
