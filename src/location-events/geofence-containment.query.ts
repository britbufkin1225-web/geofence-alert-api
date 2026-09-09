import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { GEOFENCE_RADIUS_MAX_METERS } from '../geofences/dto/geofence.constants';
import { PrismaService } from '../prisma/prisma.service';

/**
 * One row of the containment query: an active geofence of the caller's tenant
 * whose circle contains the evaluated observation.
 */
export interface GeofenceMatchRow {
  geofenceId: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  distanceMeters: number;
}

/**
 * Slack added to the bounding prefilter, in meters.
 *
 * The prefilter must never exclude a geofence the authoritative predicate would
 * accept. `ST_DWithin` and `ST_Distance` do not agree to the last bit (see
 * `containmentStatement`), and `ST_DWithin` is the stricter of the two, so a
 * prefilter set exactly at the maximum radius could drop a geofence whose radius
 * sits at that maximum and whose distance is within a nanometer of it. One meter
 * of slack is many orders of magnitude larger than that disagreement while
 * remaining negligible against the 5 km ceiling: it widens the index probe's
 * bounding box and nothing else.
 */
export const CONTAINMENT_PREFILTER_MARGIN_METERS = 1;

/** The constant-radius bound the index-servable prefilter probes with. */
export const CONTAINMENT_PREFILTER_METERS =
  GEOFENCE_RADIUS_MAX_METERS + CONTAINMENT_PREFILTER_MARGIN_METERS;

/**
 * The single spatial statement of GF-5 — the only expression of containment in
 * the application, written once.
 *
 * Why raw SQL: Prisma cannot reference `Unsupported("geography(Point, 4326)")`
 * columns, so PostGIS predicates are unreachable through the query builder.
 * Every value below is bound as a parameter (`${...}` becomes `$1`, `$2`, ...);
 * no identifier, coordinate, radius or tenant id is ever interpolated into the
 * statement text.
 *
 * Why the event is joined rather than passed in as coordinates: the
 * authoritative observation point is the stored, generated `observedPoint`
 * column. Rebuilding a point from scalars in the application would introduce a
 * second representation that could disagree with it, and would open the door to
 * evaluating arbitrary caller-supplied coordinates. The event row is re-qualified
 * by tenant here as well, so the statement is safe to read in isolation.
 *
 * Spatial contract:
 *
 * - `geography` operands with SRID 4326, so the radius and the returned distance
 *   are meters on the WGS 84 spheroid — never degrees, and never planar.
 * - Containment is `ST_Distance(center, point) <= "radiusMeters"`, so a point
 *   exactly on the boundary is inside.
 * - `"isActive" = TRUE` and the tenant predicate are part of the join, so an
 *   inactive or foreign geofence is never a candidate rather than being filtered
 *   out afterwards.
 *
 * Why `ST_Distance(...) <= "radiusMeters"` and not `ST_DWithin(...)` as the
 * authoritative predicate: for geography operands the two do not agree at the
 * boundary. `ST_DWithin` computes its own, very slightly larger distance, so on
 * PostGIS 3.4 `ST_DWithin(a, b, ST_Distance(a, b))` returns FALSE — measured at
 * roughly 5e-10 m over a 250 m separation, and reproduced by the integration
 * suite so the behavior is pinned rather than assumed. Using `ST_DWithin` as the
 * decision would therefore exclude a point sitting exactly on the configured
 * radius and would let the response contradict itself, reporting a distance
 * equal to the radius for a geofence it had just excluded. `ST_Distance` decides
 * containment and computes the returned value, so the two can never disagree and
 * `distance <= radius` holds exactly.
 *
 * Index posture: `ST_DWithin` remains in the statement as a bounding prefilter,
 * because it is the form PostGIS can answer from `Geofence_centerPoint_gist_idx`
 * (it expands to `"centerPoint" && _ST_Expand(point, bound)`), which neither
 * `ST_Distance` nor a per-row `"radiusMeters"` argument can be. Its bound is a
 * constant and a strict superset: the database CHECK constraint
 * `Geofence_radiusMeters_max_check` caps every stored radius at
 * GEOFENCE_RADIUS_MAX_METERS, and CONTAINMENT_PREFILTER_MARGIN_METERS covers the
 * `ST_DWithin`/`ST_Distance` disagreement described above. The integration suite
 * asserts that cap, so raising it in a future migration without revisiting this
 * statement fails a test instead of silently dropping matches.
 *
 * Ordering is total and explicit: ascending distance, then ascending geofence
 * id. Nothing relies on physical row order.
 *
 * Exported so the integration suite can obtain a query plan for exactly this
 * statement rather than for a hand-copied approximation of it.
 */
export function containmentStatement(
  locationEventId: string,
  tenantId: string,
): Prisma.Sql {
  return Prisma.sql`
    SELECT "geofence"."id" AS "geofenceId",
           "geofence"."name" AS "name",
           "geofence"."latitude" AS "latitude",
           "geofence"."longitude" AS "longitude",
           "geofence"."radiusMeters" AS "radiusMeters",
           ST_Distance("geofence"."centerPoint", "event"."observedPoint")
             AS "distanceMeters"
    FROM "LocationEvent" AS "event"
    JOIN "Geofence" AS "geofence"
      ON "geofence"."tenantId" = ${tenantId}
     AND "geofence"."isActive" = TRUE
     AND ST_DWithin(
           "geofence"."centerPoint",
           "event"."observedPoint",
           ${CONTAINMENT_PREFILTER_METERS}::double precision
         )
     AND ST_Distance("geofence"."centerPoint", "event"."observedPoint")
           <= "geofence"."radiusMeters"
    WHERE "event"."id" = ${locationEventId}
      AND "event"."tenantId" = ${tenantId}
    ORDER BY "distanceMeters" ASC, "geofenceId" ASC
  `;
}

/**
 * The spatial boundary of GF-5. It owns one statement and performs no mapping,
 * so the containment predicate stays visible and reviewable in one place.
 */
@Injectable()
export class GeofenceContainmentQuery {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the active geofences of `tenantId` that contain the stored point of
   * location event `locationEventId`, nearest first. Read-only.
   */
  async findContainingGeofences(
    locationEventId: string,
    tenantId: string,
  ): Promise<GeofenceMatchRow[]> {
    return this.prisma.$queryRaw<GeofenceMatchRow[]>(
      containmentStatement(locationEventId, tenantId),
    );
  }
}
