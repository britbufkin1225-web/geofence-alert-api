/**
 * The GF-5 point-in-circle evaluation response.
 *
 * The payload describes one already-persisted observation and the active
 * geofences of the caller's tenant that contain it. It is a pure read: nothing
 * here is stored, and the same request against unchanged state produces the same
 * bytes.
 *
 * Deliberately absent:
 *
 * - `tenantId`, which the caller already proved by authenticating, and which is
 *   never echoed back as if it were a request parameter;
 * - `observedPoint` / `centerPoint`, the derived geography columns that no
 *   application-facing contract exposes;
 * - any evaluation timestamp, generated id or other request-time-dependent
 *   value, which would make two identical requests differ;
 * - `accuracyMeters`, because GF-5 does not let reported accuracy expand or
 *   shrink a geofence radius, and returning it beside a containment answer would
 *   imply that it did;
 * - transition, alert or delivery state, which is later-phase work.
 */
export interface GeofenceMatchDto {
  /** Identifier of the matched geofence. */
  geofenceId: string;

  /** The geofence's public name, as returned by the geofence endpoints. */
  name: string;

  /** Center latitude of the matched circle, in degrees (WGS 84). */
  latitude: number;

  /** Center longitude of the matched circle, in degrees (WGS 84). */
  longitude: number;

  /** The configured radius, in meters. */
  radiusMeters: number;

  /**
   * Geodesic distance from the observation to the circle center, in meters,
   * computed by PostGIS and rounded for serialization only. Containment is
   * boundary-inclusive, so this value is always `<= radiusMeters`.
   */
  distanceMeters: number;
}

export interface GeofenceEvaluationResponseDto {
  /** The evaluated location event. */
  locationEventId: string;

  /** The device that reported it, as already stored on the event. */
  trackedDeviceId: string;

  /** The stored observation instant, serialized as an ISO-8601 UTC string. */
  observedAt: Date;

  /** The stored observation latitude, in degrees (WGS 84). */
  latitude: number;

  /** The stored observation longitude, in degrees (WGS 84). */
  longitude: number;

  /**
   * Active same-tenant geofences containing the observation, ordered by
   * ascending distance and then by ascending geofence id. Empty when the
   * observation falls outside every one of them — which is a successful
   * evaluation, not an error.
   */
  matches: GeofenceMatchDto[];

  /** Always equal to `matches.length`. */
  matchCount: number;
}
