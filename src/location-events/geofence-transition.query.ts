import { Injectable } from '@nestjs/common';
import {
  GeofenceContainmentState,
  GeofenceTransition,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  CONTAINMENT_DISTANCE_METERS,
  CONTAINMENT_PREDICATE,
} from './geofence-containment.query';
import {
  GeofenceAlertIndex,
  GeofenceAlertService,
} from './geofence-alert.service';

/**
 * One evaluated geofence for one observation.
 *
 * `advancedTransition` is non-null exactly when this observation became the
 * device's newest accepted state for the geofence. The database computes it
 * inside the upsert, from the row it is actually overwriting, so it can never
 * describe a comparison against a stale read.
 */
export interface GeofenceTransitionRow {
  geofenceId: string;
  name: string;
  radiusMeters: number;
  distanceMeters: number;
  state: GeofenceContainmentState;
  advancedTransition: GeofenceTransition | null;

  /**
   * The device this observation belongs to, and the instant its source reports
   * it was taken. Both are read from the stored `LocationEvent`, not accepted
   * from anyone, and both are carried out of the statement because GF-7 records
   * them on an alert and must not re-derive them from a second, later read.
   */
  trackedDeviceId: string;
  observedAt: Date;
}

/** The state a non-advancing observation was measured against. */
export interface GeofenceStoredStateRow {
  geofenceId: string;
  lastTransition: GeofenceTransition;
  lastLocationEventId: string;
}

export interface GeofenceTransitionQueryResult {
  rows: GeofenceTransitionRow[];
  stored: GeofenceStoredStateRow[];

  /**
   * The durable alerts this observation's accepted crossings resolved to (GF-7),
   * indexed by geofence. Empty when the observation crossed nothing — a baseline,
   * a stay and a superseded observation all produce none.
   */
  alerts: GeofenceAlertIndex;
}

/**
 * The single transition statement of GF-6: evaluate one stored observation
 * against every applicable geofence and, in the same statement, advance the
 * device's persisted state wherever this observation is the newest one seen.
 *
 * Why one statement. Reading the previous state and then writing the new one as
 * two round trips is a lost-update race: two observations of the same device can
 * both read "OUTSIDE" and both report ENTER. `INSERT ... ON CONFLICT DO UPDATE`
 * is a single atomic operation per row — PostgreSQL serializes concurrent
 * writers on the conflicting tuple and re-evaluates the `DO UPDATE` against the
 * row version that actually won — so the comparison and the advancement cannot
 * be separated by another writer. No advisory lock, queue or retry loop is
 * involved, and no second row for the same identity can be created.
 *
 * The applicable set. Every ACTIVE geofence of the caller's tenant is evaluated,
 * not only the ones that contain the point: an EXIT is only observable by
 * measuring a geofence the device is no longer inside. Inactive geofences are
 * excluded by the join, so deactivating one produces no row, no comparison and
 * therefore no EXIT — its state is retired separately, when the deactivation is
 * accepted. GF-5's `ST_DWithin` prefilter is deliberately absent: it is an index
 * bound for "which circles contain this point", and applying it here would drop
 * exactly the distant geofences an EXIT depends on. The cost is one distance per
 * active geofence of one tenant.
 *
 * Containment is not restated. `CONTAINMENT_PREDICATE` and
 * `CONTAINMENT_DISTANCE_METERS` are embedded from the GF-5 module, so the
 * boundary rule (`ST_Distance(...) <= "radiusMeters"`, boundary inside) has one
 * definition for both phases.
 *
 * Tenant scope. The bound tenant id is the authoritative value from the verified
 * principal. It qualifies the event lookup, the geofence join and the inserted
 * row, and the composite foreign keys on `GeofenceDeviceState` make a row whose
 * tenant disagrees with its geofence, device or source event impossible to
 * store. The device is taken from the event row itself, never from a caller.
 *
 * Ordering. `("lastObservedAt", "lastLocationEventId")` is the canonical total
 * order: the source's own observation instant first, the stable event id as the
 * tie-break. The `WHERE` on the `DO UPDATE` advances state only on a strictly
 * greater pair, so an out-of-order event cannot regress state, an equal pair
 * (the same event replayed) cannot advance it twice, and two events sharing an
 * instant resolve to the same winner whichever arrives first. Server receipt
 * time is never consulted.
 *
 * Every value is a bound parameter; no identifier, coordinate or id is
 * interpolated into the statement text.
 *
 * Geofence rows are share-locked in ID order before advancement. Deactivation
 * must either retire state after this transaction or finish first, in which
 * case the locking read rechecks isActive. Without this lock, an evaluation
 * could recreate state after the deactivation transaction's delete.
 *
 * Exported so tests can plan and read exactly this statement.
 */
export function evaluateAndAdvanceStatement(
  locationEventId: string,
  tenantId: string,
): Prisma.Sql {
  return Prisma.sql`
    WITH "evaluated" AS (
      SELECT "event"."trackedDeviceId" AS "trackedDeviceId",
             "event"."id" AS "locationEventId",
             "event"."observedAt" AS "observedAt",
             "geofence"."id" AS "geofenceId",
             "geofence"."name" AS "name",
             "geofence"."radiusMeters" AS "radiusMeters",
             ${CONTAINMENT_DISTANCE_METERS} AS "distanceMeters",
             (CASE WHEN ${CONTAINMENT_PREDICATE} THEN 'INSIDE' ELSE 'OUTSIDE' END)
               ::"GeofenceContainmentState" AS "state"
      FROM "LocationEvent" AS "event"
      JOIN "Geofence" AS "geofence"
        ON "geofence"."tenantId" = ${tenantId}
       AND "geofence"."isActive" = TRUE
      WHERE "event"."id" = ${locationEventId}
        AND "event"."tenantId" = ${tenantId}
      ORDER BY "geofence"."id"
      FOR SHARE OF "geofence"
    ),
    "advanced" AS (
      INSERT INTO "GeofenceDeviceState" (
        "tenantId",
        "trackedDeviceId",
        "geofenceId",
        "state",
        "lastTransition",
        "lastLocationEventId",
        "lastObservedAt",
        "createdAt",
        "updatedAt"
      )
      SELECT ${tenantId},
             "evaluated"."trackedDeviceId",
             "evaluated"."geofenceId",
             "evaluated"."state",
             (CASE
                WHEN "evaluated"."state" = 'INSIDE' THEN 'BASELINE_INSIDE'
                ELSE 'BASELINE_OUTSIDE'
              END)::"GeofenceTransition",
             "evaluated"."locationEventId",
             "evaluated"."observedAt",
             CURRENT_TIMESTAMP,
             CURRENT_TIMESTAMP
      FROM "evaluated"
      ON CONFLICT ("tenantId", "trackedDeviceId", "geofenceId") DO UPDATE
      SET "state" = EXCLUDED."state",
          "lastTransition" = (CASE
            WHEN "GeofenceDeviceState"."state" = EXCLUDED."state"
              THEN (CASE
                      WHEN EXCLUDED."state" = 'INSIDE' THEN 'STAY_INSIDE'
                      ELSE 'STAY_OUTSIDE'
                    END)
            WHEN EXCLUDED."state" = 'INSIDE' THEN 'ENTER'
            ELSE 'EXIT'
          END)::"GeofenceTransition",
          "lastLocationEventId" = EXCLUDED."lastLocationEventId",
          "lastObservedAt" = EXCLUDED."lastObservedAt",
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE (EXCLUDED."lastObservedAt", EXCLUDED."lastLocationEventId")
          > ("GeofenceDeviceState"."lastObservedAt",
             "GeofenceDeviceState"."lastLocationEventId")
      RETURNING "geofenceId", "lastTransition"
    )
    SELECT "evaluated"."geofenceId" AS "geofenceId",
           "evaluated"."trackedDeviceId" AS "trackedDeviceId",
           "evaluated"."observedAt" AS "observedAt",
           "evaluated"."name" AS "name",
           "evaluated"."radiusMeters" AS "radiusMeters",
           "evaluated"."distanceMeters" AS "distanceMeters",
           "evaluated"."state" AS "state",
           "advanced"."lastTransition" AS "advancedTransition"
    FROM "evaluated"
    LEFT JOIN "advanced"
      ON "advanced"."geofenceId" = "evaluated"."geofenceId"
    ORDER BY "distanceMeters" ASC, "geofenceId" ASC
  `;
}

/**
 * Reads the state that already owns each geofence this observation did not
 * advance, so the classification can distinguish a replay of the very event that
 * wrote the state from a genuinely older observation.
 *
 * Issued as a separate statement, after the upsert and inside the same
 * transaction, on purpose: a common-table expression would see the snapshot the
 * statement began with, which is exactly the read the upsert exists to avoid
 * trusting. The upsert retains conflicting-row locks even when its advancement
 * guard is false; another writer cannot change those rows before this read.
 *
 * The device is joined from the event rather than passed in, so this read cannot
 * be aimed at another device, and the tenant predicate is explicit on both
 * tables.
 */
export function storedStateStatement(
  locationEventId: string,
  tenantId: string,
  geofenceIds: string[],
): Prisma.Sql {
  return Prisma.sql`
    SELECT "state"."geofenceId" AS "geofenceId",
           "state"."lastTransition" AS "lastTransition",
           "state"."lastLocationEventId" AS "lastLocationEventId"
    FROM "GeofenceDeviceState" AS "state"
    JOIN "LocationEvent" AS "event"
      ON "event"."id" = ${locationEventId}
     AND "event"."tenantId" = ${tenantId}
     AND "event"."trackedDeviceId" = "state"."trackedDeviceId"
    WHERE "state"."tenantId" = ${tenantId}
      AND "state"."geofenceId" IN (${Prisma.join(geofenceIds)})
  `;
}

/**
 * The database boundary of GF-6, and the transaction the GF-7 alert write joins.
 *
 * It owns the two statements above and performs no classification itself, so
 * what the database decides stays reviewable in one place. The alert step it
 * calls is a collaborator with its own policy, statements and tests; what this
 * class contributes to GF-7 is only the transaction the alert must commit
 * inside.
 */
@Injectable()
export class GeofenceTransitionQuery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: GeofenceAlertService,
  ) {}

  /**
   * Evaluates `locationEventId` against the active geofences of `tenantId`,
   * advancing the persisted device state wherever this observation is newer than
   * the one that state came from, and returns both halves of the answer.
   *
   * The three steps run in one transaction so the follow-up read cannot be
   * interleaved with a third party's advancement of a row this call has already
   * resolved. The upsert is a single statement, so a failure of any query leaves
   * state either fully advanced or untouched — never partially.
   *
   * Since GF-7 the alert write is the third step, and this transaction is why it
   * lives here rather than one layer up in the ingestion service. A crossing is
   * only ever visible in the instant it is classified: once the state row moves
   * on, nothing can reconstruct that a boundary was crossed. So an accepted
   * `ENTER` or `EXIT` and its alert must become durable together, and the only
   * transaction that owns the advancement is this one. The alert boundary is
   * still a separate, separately testable collaborator — it is handed this
   * transaction, it does not open one.
   *
   * The alert step runs whether or not anything advanced. A replay of the event
   * that owns a crossing advances nothing and must still resolve to that
   * crossing's alert, which is also what repairs an alert lost to a failure
   * between attempts.
   */
  async evaluateAndAdvance(
    locationEventId: string,
    tenantId: string,
  ): Promise<GeofenceTransitionQueryResult> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<GeofenceTransitionRow[]>(
        evaluateAndAdvanceStatement(locationEventId, tenantId),
      );

      const notAdvanced = rows
        .filter((row) => row.advancedTransition === null)
        .map((row) => row.geofenceId);

      const stored =
        notAdvanced.length === 0
          ? []
          : await tx.$queryRaw<GeofenceStoredStateRow[]>(
              storedStateStatement(locationEventId, tenantId, notAdvanced),
            );

      const alerts = await this.alerts.record(
        tx,
        tenantId,
        locationEventId,
        rows,
        stored,
      );

      return { rows, stored, alerts };
    });
  }
}
