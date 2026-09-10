import { Injectable } from '@nestjs/common';
import { GeofenceTransition, Prisma } from '@prisma/client';

/**
 * One crossing that the database has already accepted, ready to be recorded.
 *
 * Every field is copied from a row PostgreSQL produced while advancing GF-6
 * transition state in the current transaction. The device and instant come from
 * validated ingestion input through the stored location event, the geofence
 * from the evaluated set, and the direction
 * from the classification the upsert computed.
 */
export interface GeofenceAlertCandidate {
  geofenceId: string;
  trackedDeviceId: string;
  transition: GeofenceTransition;
  observedAt: Date;
}

/** A persisted alert, as the ingestion response needs to see it. */
export interface GeofenceAlertRow {
  id: string;
  geofenceId: string;
  transition: GeofenceTransition;
  createdAt: Date;
}

/**
 * Reads back the alerts that belong to the crossings this observation currently
 * owns.
 *
 * The join is the point of the statement, not decoration. An alert is only the
 * right answer for this response if the transition state it describes still says
 * so, so the row is required to agree with `GeofenceDeviceState` on all five
 * parts of its identity: tenant, device, geofence, the observation that owns the
 * state, and the direction that state recorded. Two defects are impossible as a
 * result rather than merely unlikely:
 *
 *   * An older alert for the same device and geofence — a previous ENTER, before
 *     the device left and came back — cannot be attached to this request, because
 *     the state no longer cites that observation.
 *   * An alert whose direction disagrees with the stored crossing cannot be
 *     returned at all.
 *
 * The join sees this transaction's uncommitted state writes. It is an additional
 * consistency check, not an atomicity mechanism on its own: an insert on another
 * connection could commit before read-back fails. Sharing the transaction client
 * for advancement, insertion and read-back is what prevents orphan writes.
 *
 * Every value is a bound parameter; no identifier or id is interpolated into the
 * statement text. Exported so tests can read exactly this statement.
 */
export function alertsForCrossingsStatement(
  tenantId: string,
  locationEventId: string,
  geofenceIds: string[],
): Prisma.Sql {
  return Prisma.sql`
    SELECT "alert"."id" AS "id",
           "alert"."geofenceId" AS "geofenceId",
           "alert"."transition" AS "transition",
           "alert"."createdAt" AS "createdAt"
    FROM "AlertEvent" AS "alert"
    JOIN "GeofenceDeviceState" AS "state"
      ON "state"."tenantId" = "alert"."tenantId"
     AND "state"."trackedDeviceId" = "alert"."trackedDeviceId"
     AND "state"."geofenceId" = "alert"."geofenceId"
     AND "state"."lastLocationEventId" = "alert"."sourceLocationEventId"
     AND "state"."lastTransition" = "alert"."transition"
    WHERE "alert"."tenantId" = ${tenantId}
      AND "alert"."sourceLocationEventId" = ${locationEventId}
      AND "alert"."geofenceId" IN (${Prisma.join(geofenceIds)})
  `;
}

/**
 * The database boundary of GF-7.
 *
 * It records accepted crossings and reads back what is now stored for the event
 * being ingested. It classifies nothing and decides nothing about which
 * transitions deserve an alert — that is `geofence-alert.policy.ts` — so the two
 * questions ("is this a crossing?" and "is this crossing already recorded?")
 * stay separately reviewable.
 *
 * Every method takes the caller's transaction client rather than opening its
 * own. That is the phase's central safety property: the alert insert runs inside
 * the transaction that advanced the transition state it describes, so the pair
 * commits together or not at all.
 */
@Injectable()
export class GeofenceAlertQuery {
  /**
   * Records every candidate crossing that is not recorded yet, then returns the
   * stored alert for each one.
   *
   * Deduplication is `AlertEvent_crossing_key` — a real unique index on
   * (tenantId, trackedDeviceId, geofenceId, sourceLocationEventId, transition) —
   * combined with `skipDuplicates`, which Prisma compiles to
   * `INSERT ... ON CONFLICT DO NOTHING`. There is no "does it already exist?"
   * read before the write, because that check and the write it guards cannot be
   * made atomic with respect to another connection doing the same thing: two
   * concurrent replays would both find nothing and both insert. Here the second
   * writer's row is discarded by PostgreSQL, on the index, and a conflict is
   * therefore a successful idempotent outcome rather than an error to translate.
   *
   * The read-back is a separate statement rather than `INSERT ... RETURNING`
   * precisely because a conflicting insert returns nothing: a replay must answer
   * with the alert that already exists, which only a read can produce. It runs in
   * the same transaction, after the insert, so it sees this transaction's own
   * rows — both the alerts and the transition state they are checked against.
   */
  async persistAndRead(
    tx: Prisma.TransactionClient,
    tenantId: string,
    locationEventId: string,
    candidates: GeofenceAlertCandidate[],
  ): Promise<GeofenceAlertRow[]> {
    if (candidates.length === 0) {
      return [];
    }

    await tx.alertEvent.createMany({
      data: candidates.map((candidate) => ({
        tenantId,
        trackedDeviceId: candidate.trackedDeviceId,
        geofenceId: candidate.geofenceId,
        sourceLocationEventId: locationEventId,
        transition: candidate.transition,
        observedAt: candidate.observedAt,
      })),
      skipDuplicates: true,
    });

    return tx.$queryRaw<GeofenceAlertRow[]>(
      alertsForCrossingsStatement(
        tenantId,
        locationEventId,
        candidates.map((candidate) => candidate.geofenceId),
      ),
    );
  }
}
