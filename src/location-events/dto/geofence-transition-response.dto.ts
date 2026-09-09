import { GeofenceContainmentState, GeofenceTransition } from '@prisma/client';

export { GeofenceContainmentState, GeofenceTransition };

/**
 * How one accepted observation relates to one active geofence of the caller's
 * tenant (GF-6).
 *
 * This describes containment and its change. It is explicitly NOT an alert: no
 * alert, notification or delivery record exists in GF-6, and nothing in this
 * shape claims that anything was sent.
 *
 * Deliberately absent, for the same reasons as the GF-5 evaluation contract:
 * `tenantId`, which the caller proved by authenticating; the derived
 * `centerPoint` / `observedPoint` geography columns; and any evaluation
 * timestamp or generated id, which would make two identical requests differ.
 */
export interface GeofenceTransitionDto {
  /** Identifier of the evaluated geofence. */
  geofenceId: string;

  /** The geofence's public name, as returned by the geofence endpoints. */
  name: string;

  /** The configured radius, in meters. */
  radiusMeters: number;

  /**
   * Geodesic distance from this observation to the circle center, in meters,
   * computed by PostGIS and rounded for serialization only — the same value, by
   * the same rule, that GF-5 returns. It never participates in the containment
   * decision, so a rounded distance may sit up to half a millimeter above an
   * unrounded radius while the observation is genuinely inside.
   */
  distanceMeters: number;

  /**
   * Where THIS observation sits relative to the circle, boundary inclusive.
   *
   * It always describes the observation carried by this request. When
   * `stateAdvanced` is `false` it is therefore not necessarily the device's
   * current persisted state, which a newer observation owns.
   */
  state: GeofenceContainmentState;

  /**
   * How the observation classifies against the state that preceded it.
   *
   * - `BASELINE_INSIDE` / `BASELINE_OUTSIDE` — the first accepted observation
   *   for this device and geofence, or the first after the geofence was
   *   reactivated. Nothing is known about a previous position, so no crossing is
   *   claimed.
   * - `ENTER` / `EXIT` — the device crossed the boundary since the previous
   *   accepted observation.
   * - `STAY_INSIDE` / `STAY_OUTSIDE` — no crossing.
   *
   * A replay of the event that wrote the current state repeats that event's
   * original classification verbatim. An observation older than the current
   * state reports `STAY_INSIDE` / `STAY_OUTSIDE` for its own containment: it
   * says nothing about a change, and is never reported as `ENTER` or `EXIT`.
   */
  transition: GeofenceTransition;

  /**
   * `true` when this observation became the device's newest accepted state for
   * the geofence. `false` when it did not — because it is older than the stored
   * state, or because it is a replay of the event that already wrote it. A
   * `false` here is a normal, successful outcome, not a failure.
   */
  stateAdvanced: boolean;
}
